import { highlight, supportsLanguage } from 'cli-highlight';
import * as path from 'path';

const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'ini',
    '.ini': 'ini',
    '.html': 'html',
    '.htm': 'html',
    '.xml': 'xml',
    '.css': 'css',
    '.scss': 'scss',
    '.sql': 'sql',
    '.lua': 'lua',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.vim': 'vim',
    '.dockerfile': 'dockerfile',
};

export function languageForPath(filePath: string): string | null {
    const base = path.basename(filePath).toLowerCase();
    if (base === 'dockerfile') return 'dockerfile';
    if (base === 'makefile') return 'makefile';
    const ext = path.extname(filePath).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) return null;
    return supportsLanguage(lang) ? lang : null;
}

export function highlightCode(text: string, filePath: string): string {
    const lang = languageForPath(filePath);
    if (!lang) return text;
    try {
        return highlight(text, { language: lang, ignoreIllegals: true });
    } catch {
        return text;
    }
}
