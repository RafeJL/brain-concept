// Plain JavaScript with JSX parses with the JavaScript grammar.
export const Ping = () => <button onClick={() => fetch("/ping")}>Ping</button>; // seam: call GET /ping
