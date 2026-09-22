const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg'); // Production PostgreSQL package

const app = express();
const server = http.createServer(app);

// Use connection pooling to interact cleanly with Render Postgres
// During local testing, this will gracefully fall back if DATABASE_URL is not set yet
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/tetris', 
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create the chips table automatically if it doesn't exist yet on Render
const initDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                chips INT DEFAULT 250 NOT NULL
            );
        `);
        console.log("✅ Render PostgreSQL 'players' table initialized successfully.");
    } catch (err) {
        console.log("⚠️ Database warning: Local Postgres not connected. Continuing in offline sandbox mode...");
    }
};
initDatabase();

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const MAX_ROOMS = 50;
const rooms = {}; 
const lobbyChat = [];

for (let i = 1; i <= MAX_ROOMS; i++) {
    rooms[i] = { id: i, status: 'Lobby', players: [], spectators: [], currentTurnIdx: 0, totalPot: 0, betAmount: 0, gameMode: 'easy', boards: {} };
}

io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // PROFILE LOGIN: Check Render SQL database or insert a fresh ledger profile
    socket.on('player-login', async ({ username }) => {
        try {
            let res = await pool.query('SELECT * FROM players WHERE username = \$1', [username]);
            let playerChips = 250;

            if (res && res.rows && res.rows.length > 0) {
                playerChips = res.rows[0].chips; // FIX: Added [0] index to read row data safely
                console.log(`💾 Loaded SQL Profile: ${username} (${playerChips} Chips)`);
            } else {
                try {
                    await pool.query('INSERT INTO players (username, chips) VALUES (\$1, \$2)', [username, 250]);
                    console.log(`🆕 Registered New SQL Profile: ${username} (250 Chips)`);
                } catch(e) {
                    // Local fallback handler if database engine is missing entirely
                }
            }

            socket.emit('init-lobby', { rooms, chat: lobbyChat, username, chips: playerChips });
        } catch (err) {
            // Local sandbox fallback so you can continue testing without a running local database
            console.log(`🎮 Sandbox Mode: Logging in user ${username} offline.`);
            socket.emit('init-lobby', { rooms, chat: lobbyChat, username, chips: 250 });
        }
    });

    socket.on('send-chat', (data) => {
        const msg = { user: data.user, text: data.text, time: new Date().toLocaleTimeString() };
        lobbyChat.push(msg);
        if (lobbyChat.length > 40) lobbyChat.shift();
        io.emit('receive-chat', msg);
    });

    socket.on('join-room', ({ roomId, username, chips }) => {
        const room = rooms[roomId];
        if (!room) return;
        socket.join(`room-${roomId}`);
        socket.roomId = roomId;
        socket.username = username;

        if (room.players.length < 6 && room.status === 'Lobby') {
            room.players.push({ id: socket.id, name: username, chips: parseInt(chips), eliminated: false, score: 0, level: 1 });
            io.emit('room-update', room);
        } else {
            room.spectators.push({ id: socket.id, name: username });
            socket.emit('spectate-joined', { room });
            io.emit('room-update', room);
        }
    });

    // Sync chip balances into Render persistent tables when updates fire
    socket.on('update-wallet-chips', async ({ username, finalChips }) => {
        try {
            await pool.query('UPDATE players SET chips = \$1 WHERE username = \$2', [finalChips, username]);
            console.log(`💰 Render SQL Wallet Saved: ${username} -> ${finalChips} Chips`);
        } catch (err) {
            // Silently catch local fallbacks
        }
    });

    socket.on('sync-board-matrix', (data) => {
        const room = rooms[socket.roomId];
        if (room) {
            room.boards[socket.id] = { grid: data.grid, score: data.score, level: data.level, lines: data.lines, curPlayer: data.curPlayer };
            socket.to(`room-${socket.roomId}`).emit('spectate-frame', { boards: room.boards });
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            delete room.boards[socket.id];
            if (room.players.length === 0) { room.status = 'Lobby'; room.boards = {}; }
            io.emit('room-update', room);
        }
    });
});

const PORT = process.env.PORT || 3050;
server.listen(PORT, () => console.log(`🚀 Server listening smoothly on http://localhost:${PORT}`));
