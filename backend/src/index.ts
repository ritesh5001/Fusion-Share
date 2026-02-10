import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 8080;


enum MessageType {
    // Room management
    CREATE_ROOM = 'CREATE_ROOM',
    JOIN_ROOM = 'JOIN_ROOM',
    ROOM_CREATED = 'ROOM_CREATED',
    ROOM_JOINED = 'ROOM_JOINED',
    PEER_JOINED = 'PEER_JOINED',
    PEER_DISCONNECTED = 'PEER_DISCONNECTED',
    ERROR = 'ERROR',

    // WebRTC signaling (relay only - no inspection)
    RTC_OFFER = 'RTC_OFFER',
    RTC_ANSWER = 'RTC_ANSWER',
    ICE_CANDIDATE = 'ICE_CANDIDATE'
}

// Room structure
interface Room {
    roomId: string;
    sender: WebSocket;
    receiver: WebSocket | null;
    createdAt: Date;
}

// In-memory room store
const rooms = new Map<string, Room>();

// Socket to room mapping for cleanup
const socketToRoom = new Map<WebSocket, string>();

// Generate a short, human-readable room ID (4 characters)
function generateRoomId(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
    let roomId: string;
    do {
        roomId = Array.from({ length: 4 }, () =>
            chars[Math.floor(Math.random() * chars.length)]
        ).join('');
    } while (rooms.has(roomId)); // Ensure uniqueness
    return roomId;
}

// Send message helper
function sendMessage(ws: WebSocket, type: MessageType, payload: Record<string, unknown> = {}) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

// Get the peer socket in a room
function getPeerSocket(ws: WebSocket, room: Room): WebSocket | null {
    if (room.sender === ws) {
        return room.receiver;
    } else if (room.receiver === ws) {
        return room.sender;
    }
    return null;
}

const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected');

    ws.on('message', (data: Buffer) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('Received:', message.type);

            switch (message.type) {
                case MessageType.CREATE_ROOM: {
                    // Generate unique room ID
                    const roomId = generateRoomId();

                    // Create room with this socket as sender
                    const room: Room = {
                        roomId,
                        sender: ws,
                        receiver: null,
                        createdAt: new Date()
                    };

                    rooms.set(roomId, room);
                    socketToRoom.set(ws, roomId);

                    console.log(`Room created: ${roomId}`);
                    sendMessage(ws, MessageType.ROOM_CREATED, { roomId });
                    break;
                }

                case MessageType.JOIN_ROOM: {
                    const { roomId } = message;

                    // Validate room ID provided
                    if (!roomId) {
                        sendMessage(ws, MessageType.ERROR, { message: 'Room code is required' });
                        break;
                    }

                    // Check if room exists
                    const room = rooms.get(roomId.toUpperCase());
                    if (!room) {
                        sendMessage(ws, MessageType.ERROR, { message: 'Room not found' });
                        break;
                    }

                    // Check if receiver slot is already taken
                    if (room.receiver) {
                        sendMessage(ws, MessageType.ERROR, { message: 'Room is full' });
                        break;
                    }

                    // Check if sender is trying to join own room
                    if (room.sender === ws) {
                        sendMessage(ws, MessageType.ERROR, { message: 'Cannot join your own room' });
                        break;
                    }

                    // Assign socket as receiver
                    room.receiver = ws;
                    socketToRoom.set(ws, roomId.toUpperCase());

                    console.log(`Receiver joined room: ${roomId}`);

                    // Notify receiver they joined successfully
                    sendMessage(ws, MessageType.ROOM_JOINED, { roomId: room.roomId });

                    // Notify sender that receiver connected
                    sendMessage(room.sender, MessageType.PEER_JOINED, { roomId: room.roomId });
                    break;
                }

                // ============================================
                // WebRTC Signaling Relay (dumb relay - no inspection)
                // ============================================

                case MessageType.RTC_OFFER: {
                    const roomId = socketToRoom.get(ws);
                    if (!roomId) {
                        console.log('RTC_OFFER: Socket not in a room');
                        break;
                    }

                    const room = rooms.get(roomId);
                    if (!room) {
                        console.log('RTC_OFFER: Room not found');
                        break;
                    }

                    const peer = getPeerSocket(ws, room);
                    if (peer) {
                        console.log(`Relaying RTC_OFFER in room ${roomId}`);
                        sendMessage(peer, MessageType.RTC_OFFER, { sdp: message.sdp });
                    }
                    break;
                }

                case MessageType.RTC_ANSWER: {
                    const roomId = socketToRoom.get(ws);
                    if (!roomId) {
                        console.log('RTC_ANSWER: Socket not in a room');
                        break;
                    }

                    const room = rooms.get(roomId);
                    if (!room) {
                        console.log('RTC_ANSWER: Room not found');
                        break;
                    }

                    const peer = getPeerSocket(ws, room);
                    if (peer) {
                        console.log(`Relaying RTC_ANSWER in room ${roomId}`);
                        sendMessage(peer, MessageType.RTC_ANSWER, { sdp: message.sdp });
                    }
                    break;
                }

                case MessageType.ICE_CANDIDATE: {
                    const roomId = socketToRoom.get(ws);
                    if (!roomId) {
                        console.log('ICE_CANDIDATE: Socket not in a room');
                        break;
                    }

                    const room = rooms.get(roomId);
                    if (!room) {
                        console.log('ICE_CANDIDATE: Room not found');
                        break;
                    }

                    const peer = getPeerSocket(ws, room);
                    if (peer) {
                        console.log(`Relaying ICE_CANDIDATE in room ${roomId}`);
                        sendMessage(peer, MessageType.ICE_CANDIDATE, { candidate: message.candidate });
                    }
                    break;
                }

                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');

        // Clean up room associations
        const roomId = socketToRoom.get(ws);
        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                if (room.sender === ws) {
                    // Sender disconnected - notify receiver and delete room
                    if (room.receiver) {
                        sendMessage(room.receiver, MessageType.PEER_DISCONNECTED, {
                            message: 'Host disconnected'
                        });
                        socketToRoom.delete(room.receiver);
                    }
                    rooms.delete(roomId);
                    console.log(`Room deleted: ${roomId} (sender disconnected)`);
                } else if (room.receiver === ws) {
                    // Receiver disconnected - notify sender and clear receiver
                    room.receiver = null;
                    sendMessage(room.sender, MessageType.PEER_DISCONNECTED, {
                        message: 'Peer disconnected'
                    });
                    console.log(`Receiver left room: ${roomId}`);
                }
            }
            socketToRoom.delete(ws);
        }
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error.message);
    });
});
