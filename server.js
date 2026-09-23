const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
// PostgreSQL Client configuration pool setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/tetris', 
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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
        console.log("⚠️ Database warning: Sandbox activated.");
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

// Initialize Room arrays
for (let i = 1; i <= MAX_ROOMS; i++) {
    rooms[i] = { id: i, status: 'Lobby', players: [], spectators: [], currentTurnIdx: 0, totalPot: 0, betAmount: 0, gameMode: 'easy', boards: {} };
}
// Unified Core Event Router Engine
io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // Persist login player identity profiles
    socket.on('player-login', async ({ username }) => {
        try {
            let result = await pool.query('SELECT * FROM players WHERE username = \$1', [username]);
            let playerChips = 250;

            if (result && result.rows && result.rows.length > 0) {
                playerChips = result.rows[0].chips; 
                console.log(`💾 Loaded SQL Profile: ${username} (${playerChips} Chips)`);
            } else {
                try {
                    await pool.query('INSERT INTO players (username, chips) VALUES (\$1, 250)', [username]);
                    console.log(`🆕 Registered New SQL Profile: ${username} (250 Chips)`);
                } catch(e) {}
            }

            socket.emit('init-lobby', { rooms, chat: lobbyChat, username, chips: playerChips });
        } catch (err) {
            console.log(`🎮 Sandbox Mode: Logging in user ${username} offline.`);
            socket.emit('init-lobby', { rooms, chat: lobbyChat, username, chips: 250 });
        }
    });
    // Option 4: Broadcasts Chat user name registry entries into room
    socket.on('send-chat', (data) => {
        const msg = { user: data.user, text: data.text, time: new Date().toLocaleTimeString() };
        lobbyChat.push(msg);
        if (lobbyChat.length > 40) lobbyChat.shift();
        io.emit('receive-chat', msg);
    });

    // Option 4 & 5: Join Room execution trackers and active population metrics
    socket.on('join-room', ({ roomId, username, chips }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        socket.join(`room-${roomId}`);
        socket.roomId = roomId;
        socket.username = username;

        if (room.players.length < 6 && room.status === 'Lobby') {
            room.players.push({ id: socket.id, name: username, chips: parseInt(chips), eliminated: false, score: 0, level: 1 });
        } else {
            room.spectators.push({ id: socket.id, name: username });
            socket.emit('spectate-joined', { room });
        }

        // Notify room of who entered (Option 4)
        const systemAlert = { user: 'SYSTEM', text: `${username} has entered the room arena.`, time: new Date().toLocaleTimeString() };
        io.to(`room-${roomId}`).emit('receive-chat', systemAlert);

        // Update everyone with new room numbers (Option 5)
        io.emit('room-update', room);
    });
    // Option 6: Custom room extraction router mechanics
    socket.on('leave-room', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            room.spectators = room.spectators.filter(s => s.id !== socket.id);
            delete room.boards[socket.id];
            if (room.players.length === 0) { room.status = 'Lobby'; room.boards = {}; }
            
            // Announce departure via text stream
            const systemAlert = { user: 'SYSTEM', text: `${socket.username || 'A player'} has left the room.`, time: new Date().toLocaleTimeString() };
            io.to(`room-${roomId}`).emit('receive-chat', systemAlert);
            
            // Evacuate the specific socket cleanly
            socket.leave(`room-${roomId}`);
            socket.roomId = null;
            
            io.emit('room-update', room);
        }
    });

    socket.on('update-wallet-chips', async ({ username, finalChips }) => {
        try {
            await pool.query('UPDATE players SET chips = \$1 WHERE username = \$2', [finalChips, username]);
            console.log(`💰 Render SQL Wallet Saved: ${username} -> ${finalChips} Chips`);
        } catch (err) {}
    });

    // Option 2: Live side-by-side feed layout synchronization streams
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
server.listen(PORT, () => console.log(`🚀 Server listening smoothly on port ${PORT}`));
