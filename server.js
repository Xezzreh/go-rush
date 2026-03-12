// --- server.js ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs'); 
const path = require('path'); 

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- SGF-Übersetzer (NEU: Akzeptiert ein Array von Lösungen) ---
function parseSGF(sgfString, msg, solutionsArray) {
    const setup = [];
    const cleanSgf = sgfString.replace(/\s+/g, ''); 
    
    const blackMatch = cleanSgf.match(/AB(\[[a-zA-Z]{2}\])+/g);
    if (blackMatch) {
        blackMatch.forEach(block => {
            const points = block.replace('AB', '').match(/[a-zA-Z]{2}/g);
            if (points) {
                points.forEach(pt => setup.push({ x: pt.toLowerCase().charCodeAt(0) - 97, y: pt.toLowerCase().charCodeAt(1) - 97, c: "black" }));
            }
        });
    }

    const whiteMatch = cleanSgf.match(/AW(\[[a-zA-Z]{2}\])+/g);
    if (whiteMatch) {
        whiteMatch.forEach(block => {
            const points = block.replace('AW', '').match(/[a-zA-Z]{2}/g);
            if (points) {
                points.forEach(pt => setup.push({ x: pt.toLowerCase().charCodeAt(0) - 97, y: pt.toLowerCase().charCodeAt(1) - 97, c: "white" }));
            }
        });
    }

    // NEU: Wandelt alle Text-Koordinaten in ein Array aus x/y-Punkten um
    const solutionCoords = solutionsArray.map(sol => ({
        x: sol.toLowerCase().charCodeAt(0) - 97, 
        y: sol.toLowerCase().charCodeAt(1) - 97
    }));

    return {
        msg: msg, 
        setup: setup,
        solution: solutionCoords // Ist jetzt eine Liste [{x,y}, {x,y}, ...]
    };
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// --- GLOBALE LEVEL LADEN ---
let globalPuzzles = [];

function loadPuzzles() {
    globalPuzzles = [];
    const puzzlesDir = path.join(__dirname, 'puzzles');
    if (!fs.existsSync(puzzlesDir)) fs.mkdirSync(puzzlesDir);

    const files = fs.readdirSync(puzzlesDir).filter(f => f.endsWith('.sgf'));
    files.forEach(file => {
        const content = fs.readFileSync(path.join(puzzlesDir, file), 'utf-8');
        const sgfParts = content.split(/(?<=\))\s*(?=\()/); 
        
        sgfParts.forEach((part, index) => {
            const cleanPart = part.trim();
            if (cleanPart.length < 10) return; 
            let msg = file.replace('.sgf', '').replace(/_/g, ' '); 
            if (sgfParts.length > 1) msg += ` (#${index + 1})`;
            
            // Finde den ersten Haupt-Zug
            const firstMoveMatch = cleanPart.match(/;[BW]\[([a-zA-Z]{2})\]/);
            if (firstMoveMatch) {
                let solutions = [firstMoveMatch[1]]; // Der erste Zug ist immer richtig
                
                // NEU: Suche nach weiteren Lösungs-Variationen (Ästen, die mit (;B oder (;W starten)
                const altMatches = cleanPart.match(/\(\s*;[BW]\[([a-zA-Z]{2})\]/g);
                if (altMatches) {
                    altMatches.forEach(m => {
                        const coords = m.match(/\[([a-zA-Z]{2})\]/)[1];
                        solutions.push(coords);
                    });
                }
                
                // Duplikate entfernen (falls Hauptzug und Variation gleich sind)
                solutions = [...new Set(solutions)];

                const setupPart = cleanPart.split(/;[BW]\[/)[0] + ")";
                
                const parsedPuzzle = parseSGF(setupPart, msg, solutions);
                if (parsedPuzzle.setup.length > 0) {
                    globalPuzzles.push(parsedPuzzle);
                }
            }
        });
    });

    if (globalPuzzles.length === 0) {
        // Fallback bekommt jetzt auch ein Array als Lösung
        globalPuzzles.push(parseSGF("(;GM[1]FF[4]SZ[19]AB[dd]AW[pp];B[qq])", "Fallback", ["qq"]));
    }
    console.log(`🚀 BEREIT: ${globalPuzzles.length} Level in der Datenbank!`);
}
loadPuzzles();

// --- MULTIPLAYER HOTEL (Räume) ---
const rooms = {};

function initRoom(roomId) {
    if (!rooms[roomId]) {
        let roomPuzzles = [...globalPuzzles];
        shuffle(roomPuzzles);
        
        rooms[roomId] = {
            id: roomId,
            players: {},
            isPlaying: false,
            currentLevel: 0,
            timeLeft: 10,
            interval: null,
            puzzles: roomPuzzles
        };
    }
}

initRoom('public');

function broadcastLeaderboard(roomId) {
    if (!rooms[roomId]) return;
    const sortedPlayers = Object.values(rooms[roomId].players).sort((a, b) => b.score - a.score);  
    io.to(roomId).emit('update_leaderboard', sortedPlayers); 
}

io.on('connection', (socket) => {
    let currentRoom = null; 

    socket.on('join_room', (data) => {
        const playerName = data.name;
        const requestedRoom = data.roomId; 

        currentRoom = requestedRoom;
        initRoom(currentRoom); 
        
        socket.join(currentRoom); 

        rooms[currentRoom].players[socket.id] = { name: playerName, score: 0, combo: 0 }; 
        console.log(`${playerName} ist Raum [${currentRoom}] beigetreten!`);
        
        socket.emit('room_joined', currentRoom);
        broadcastLeaderboard(currentRoom); 
        
        if (rooms[currentRoom].isPlaying) {
            socket.emit('game_already_started');
            if (rooms[currentRoom].currentLevel < rooms[currentRoom].puzzles.length) {
                socket.emit('new_round', rooms[currentRoom].puzzles[rooms[currentRoom].currentLevel]);
            }
        }
    });

    socket.on('start_game', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        let r = rooms[currentRoom];

        if (!r.isPlaying) {
            console.log(`🚀 SPIEL IN RAUM [${currentRoom}] WURDE GESTARTET!`);
            r.isPlaying = true;
            r.currentLevel = -1;
            for (let id in r.players) {
                r.players[id].score = 0;
                r.players[id].combo = 0;
            }
            broadcastLeaderboard(currentRoom);
            io.to(currentRoom).emit('game_starting'); 
            setTimeout(() => nextLevel(currentRoom), 1000);
        }
    });

    socket.on('guess', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        let r = rooms[currentRoom];
        const p = r.puzzles[r.currentLevel];
        if (!p || !r.isPlaying) return; 

        let player = r.players[socket.id]; 

        // NEU: Prüfe, ob der Klick in JEDER der möglichen Lösungen enthalten ist!
        const isCorrect = p.solution.some(sol => sol.x === data.x && sol.y === data.y);

        if (isCorrect) {
            player.combo += 1; 
            
            let basePoints = 100 + (r.timeLeft * 10);
            let comboBonus = (player.combo > 1) ? (player.combo - 1) * 50 : 0; 
            let totalPoints = basePoints + comboBonus;

            player.score += totalPoints; 
            
            socket.emit('correct_guess', { points: totalPoints, combo: player.combo });
            socket.to(currentRoom).emit('round_won_by_other', player.name); 
            
            for (let id in r.players) {
                if (id !== socket.id) r.players[id].combo = 0;
            }

            broadcastLeaderboard(currentRoom); 
            nextLevel(currentRoom);
        } else {
            player.combo = 0;
            socket.emit('wrong_guess');
        }
    });

    socket.on('disconnect', () => {
        if(currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            delete rooms[currentRoom].players[socket.id];
            broadcastLeaderboard(currentRoom); 
            
            if (currentRoom !== 'public' && Object.keys(rooms[currentRoom].players).length === 0) {
                clearInterval(rooms[currentRoom].interval);
                delete rooms[currentRoom];
                console.log(`🗑️ Raum [${currentRoom}] wurde gelöscht, da er leer ist.`);
            }
        }
    });
});

function nextLevel(roomId) {
    let r = rooms[roomId];
    if (!r) return;

    clearInterval(r.interval);
    r.currentLevel++;
    if (r.currentLevel >= r.puzzles.length) {
        io.to(roomId).emit('game_over'); 
        r.isPlaying = false; 
        return;
    }
    setTimeout(() => startRound(roomId), 3500); 
}

function startRound(roomId) {
    let r = rooms[roomId];
    if (!r) return;

    r.timeLeft = 10;
    io.to(roomId).emit('new_round', r.puzzles[r.currentLevel]);
    clearInterval(r.interval);
    
    r.interval = setInterval(() => {
        r.timeLeft--;
        io.to(roomId).emit('timer', r.timeLeft);
        if (r.timeLeft <= 0) {
            clearInterval(r.interval);
            
            for (let id in r.players) {
                r.players[id].combo = 0;
            }

            io.to(roomId).emit('timeout', r.puzzles[r.currentLevel].solution);
            nextLevel(roomId);
        }
    }, 1000);
}

http.listen(3000, () => {
    console.log('🚀 Server läuft auf Port 3000');
});