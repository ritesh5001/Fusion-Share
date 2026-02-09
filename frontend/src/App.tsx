import { useEffect, useState, useRef, useCallback } from 'react';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

// Message types (must match backend)
enum MessageType {
    CREATE_ROOM = 'CREATE_ROOM',
    JOIN_ROOM = 'JOIN_ROOM',
    ROOM_CREATED = 'ROOM_CREATED',
    ROOM_JOINED = 'ROOM_JOINED',
    PEER_JOINED = 'PEER_JOINED',
    PEER_DISCONNECTED = 'PEER_DISCONNECTED',
    ERROR = 'ERROR'
}

// Explicit app states - only valid transitions allowed
enum AppState {
    IDLE = 'IDLE',
    ROOM_CREATED = 'ROOM_CREATED',    // Sender waiting for receiver
    ROOM_JOINING = 'ROOM_JOINING',    // Receiver attempting to join
    CONNECTED = 'CONNECTED',          // Both devices connected
    ERROR = 'ERROR'                   // Error state (recoverable)
}

// User roles
type UserRole = 'sender' | 'receiver' | null;

// Friendly error messages
const ERROR_MESSAGES: Record<string, string> = {
    'Room not found': 'Room not found. Please check the code and try again.',
    'Room is full': 'Room already has a connected device.',
    'Connection lost': 'Connection lost. Please try again.',
    'default': 'Something went wrong. Please try again.'
};

const getFriendlyError = (message: string): string => {
    return ERROR_MESSAGES[message] || ERROR_MESSAGES['default'];
};

// ============================================================================
// COMPONENT
// ============================================================================

function App() {
    // Core state
    const [appState, setAppState] = useState<AppState>(AppState.IDLE);
    const [roomId, setRoomId] = useState<string | null>(null);
    const [userRole, setUserRole] = useState<UserRole>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // UI state
    const [isConnected, setIsConnected] = useState(false);
    const [showJoinInput, setShowJoinInput] = useState(false);
    const [joinCode, setJoinCode] = useState('');

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const mountedRef = useRef(false);

    // ============================================================================
    // WEBSOCKET MESSAGE HANDLER
    // ============================================================================

    const handleMessage = useCallback((event: MessageEvent) => {
        try {
            const message = JSON.parse(event.data);
            console.log('Received:', message);

            switch (message.type) {
                case MessageType.ROOM_CREATED:
                    setRoomId(message.roomId);
                    setAppState(AppState.ROOM_CREATED);
                    setUserRole('sender');
                    setErrorMessage(null);
                    break;

                case MessageType.ROOM_JOINED:
                    setRoomId(message.roomId);
                    setAppState(AppState.CONNECTED);
                    setUserRole('receiver');
                    setErrorMessage(null);
                    setShowJoinInput(false);
                    setJoinCode('');
                    break;

                case MessageType.PEER_JOINED:
                    setAppState(AppState.CONNECTED);
                    setErrorMessage(null);
                    break;

                case MessageType.PEER_DISCONNECTED:
                    // Sender stays in room, receiver gets kicked
                    setUserRole((currentRole) => {
                        if (currentRole === 'sender') {
                            setAppState(AppState.ROOM_CREATED);
                        } else {
                            setAppState(AppState.ERROR);
                            setRoomId(null);
                            setErrorMessage('Connection lost. Please try again.');
                            // Auto-recover to IDLE after showing error
                            setTimeout(() => setAppState(AppState.IDLE), 100);
                        }
                        return currentRole === 'sender' ? 'sender' : null;
                    });
                    break;

                case MessageType.ERROR:
                    setErrorMessage(getFriendlyError(message.message));
                    // Recover to IDLE if we were attempting an action
                    setAppState((current) => {
                        if (current === AppState.ROOM_JOINING) {
                            return AppState.IDLE;
                        }
                        return current;
                    });
                    break;

                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }, []);

    // ============================================================================
    // WEBSOCKET CONNECTION
    // ============================================================================

    const connectWebSocket = useCallback(() => {
        const ws = new WebSocket('ws://localhost:8080');
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('Connected to server');
            setIsConnected(true);
            setErrorMessage(null);
        };

        ws.onclose = () => {
            console.log('Disconnected from server');
            setIsConnected(false);
        };

        ws.onmessage = handleMessage;

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            setErrorMessage('Connection lost. Please try again.');
        };

        return ws;
    }, [handleMessage]);

    useEffect(() => {
        // Prevent double connection in Strict Mode
        if (mountedRef.current) return;
        mountedRef.current = true;

        connectWebSocket();

        return () => {
            mountedRef.current = false;
            wsRef.current?.close();
        };
    }, [connectWebSocket]);

    // ============================================================================
    // ACTIONS
    // ============================================================================

    const sendMessage = useCallback((type: MessageType, payload: Record<string, unknown> = {}) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, ...payload }));
        }
    }, []);

    const handleCreateRoom = () => {
        // Only allow from IDLE state
        if (appState !== AppState.IDLE || !isConnected) return;

        setErrorMessage(null);
        sendMessage(MessageType.CREATE_ROOM);
    };

    const handleJoinRoom = () => {
        // Only allow from IDLE state
        if (appState !== AppState.IDLE || !isConnected) return;

        setShowJoinInput(true);
        setErrorMessage(null);
    };

    const handleJoinSubmit = () => {
        const code = joinCode.trim().toUpperCase();

        if (!code) {
            setErrorMessage('Please enter a room code');
            return;
        }

        if (code.length !== 4) {
            setErrorMessage('Room code must be 4 characters');
            return;
        }

        setAppState(AppState.ROOM_JOINING);
        setErrorMessage(null);
        sendMessage(MessageType.JOIN_ROOM, { roomId: code });
    };

    const handleCancelJoin = () => {
        setShowJoinInput(false);
        setJoinCode('');
        setErrorMessage(null);
    };

    const handleLeaveRoom = () => {
        // Close WebSocket cleanly
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }

        // Reset all state to IDLE
        setAppState(AppState.IDLE);
        setRoomId(null);
        setUserRole(null);
        setErrorMessage(null);
        setShowJoinInput(false);
        setJoinCode('');

        // Reconnect after brief delay
        setTimeout(() => {
            connectWebSocket();
        }, 100);
    };

    // ============================================================================
    // STATUS TEXT
    // ============================================================================

    const getStatusText = (): string => {
        switch (appState) {
            case AppState.ROOM_CREATED:
                return 'Waiting for another device to join...';
            case AppState.ROOM_JOINING:
                return 'Joining room...';
            case AppState.CONNECTED:
                return userRole === 'sender' ? 'Device connected' : 'Connected to sender';
            default:
                return '';
        }
    };

    // ============================================================================
    // RENDER HELPERS
    // ============================================================================

    const renderRoleBadge = () => {
        if (!userRole) return null;

        return (
            <div className="role-badge">
                {userRole === 'sender' ? '📤 Sender' : '📥 Receiver'}
            </div>
        );
    };

    const renderRoomView = () => (
        <div className="room-info">
            <div className="room-code-container">
                <span className="room-code-label">Room Code</span>
                <span className="room-code">{roomId}</span>
            </div>

            {renderRoleBadge()}

            <p className="room-status">{getStatusText()}</p>

            <button
                className="btn btn-secondary"
                onClick={handleLeaveRoom}
            >
                Leave Room
            </button>
        </div>
    );

    const renderJoinForm = () => (
        <div className="join-form">
            <input
                type="text"
                className="join-input"
                placeholder="XXXX"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinSubmit()}
                maxLength={4}
                autoFocus
                disabled={appState === AppState.ROOM_JOINING}
            />
            <div className="join-actions">
                <button
                    className="btn btn-primary"
                    onClick={handleJoinSubmit}
                    disabled={!joinCode.trim() || appState === AppState.ROOM_JOINING}
                >
                    {appState === AppState.ROOM_JOINING ? 'Joining...' : 'Join'}
                </button>
                <button
                    className="btn btn-secondary"
                    onClick={handleCancelJoin}
                    disabled={appState === AppState.ROOM_JOINING}
                >
                    Cancel
                </button>
            </div>
        </div>
    );

    const renderIdleView = () => {
        // Show join form if active
        if (showJoinInput) {
            return renderJoinForm();
        }

        return (
            <div className="actions">
                <button
                    className="btn btn-primary"
                    onClick={handleCreateRoom}
                    disabled={!isConnected}
                >
                    Create Room
                </button>
                <button
                    className="btn btn-secondary"
                    onClick={handleJoinRoom}
                    disabled={!isConnected}
                >
                    Join Room
                </button>
            </div>
        );
    };

    const renderContent = () => {
        switch (appState) {
            case AppState.ROOM_CREATED:
            case AppState.CONNECTED:
                return renderRoomView();

            case AppState.ROOM_JOINING:
                return renderJoinForm();

            case AppState.IDLE:
            case AppState.ERROR:
            default:
                return renderIdleView();
        }
    };

    // ============================================================================
    // MAIN RENDER
    // ============================================================================

    return (
        <div className="container">
            <header className="header">
                <h1 className="title">Fusion Share</h1>
                <p className="subtitle">Cross-device file sharing</p>
            </header>

            <div className="status">
                <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
                <span className="status-text">
                    {isConnected ? 'Connected' : 'Connecting...'}
                </span>
            </div>

            {errorMessage && (
                <div className="error-message" role="alert">
                    {errorMessage}
                </div>
            )}

            <main className="main-content">
                {renderContent()}
            </main>

            <footer className="footer">
                <p>Works on Android, iOS & Desktop</p>
            </footer>
        </div>
    );
}

export default App;
