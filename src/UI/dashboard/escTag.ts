export function escTag(s: string): string {
    return s.replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}
