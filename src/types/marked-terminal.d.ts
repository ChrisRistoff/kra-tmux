declare module 'marked-terminal' {
    const TerminalRenderer: new (opts?: Record<string, unknown>) => unknown;
    export default TerminalRenderer;
    export { TerminalRenderer };
}
