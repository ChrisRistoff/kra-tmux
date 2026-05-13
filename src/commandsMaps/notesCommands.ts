import * as notes from '@/notes/runNotes';
import { NotesCommands } from '@/commandsMaps/types/commandTypes';

export const notesCommands: NotesCommands = {
    'open': {
        run: notes.openNote,
        description: 'Open (or create) a markdown note by name in the bundled nvim config',
        details: 'Resolves <name> under ~/.kra/notes/<name>.md (sub-directories allowed) and opens it in nvim using the bundled notes config (space leader, render-markdown, telescope, link-following, backlinks). With no name, opens the Telescope picker over all notes.',
        highlights: [
            'Opens in nvim with bundled config so behavior is identical on every machine.',
            'Auto-creates parent directories under ~/.kra/notes for category sub-paths.',
            'Bare invocation opens the fuzzy notes picker; pass a name to jump straight in.',
        ],
    },
    'new': {
        run: notes.newNote,
        description: 'Create a new note with seed frontmatter and open it',
        details: 'Like open, but refuses to overwrite an existing note and seeds the file with YAML frontmatter (created date + empty tags) plus a top-level title heading.',
        highlights: [
            'Seeds frontmatter and title to keep notes consistent.',
            'Refuses to clobber an existing note of the same name.',
            'Sub-paths like work/idea-x are supported and auto-create directories.',
        ],
    },
    'journal': {
        run: notes.journalNote,
        description: 'Open today’s journal entry (or a relative/explicit day)',
        details: 'Opens ~/.kra/notes/journal/YYYY/MM/YYYY-MM-DD.md, seeding it with frontmatter and Notes/Tasks sections on first use. Accepts no argument (today), `yesterday`, `tomorrow`, or an explicit `YYYY-MM-DD`.',
        highlights: [
            'Auto-creates the dated file under journal/YYYY/MM/.',
            'Seeds Notes + Tasks sections so each day has a consistent shape.',
            'Inside nvim: <leader>j opens today, <leader>J fuzzy-picks past entries.',
        ],
    },
    'pick': {
        run: notes.pickNote,
        description: 'Open the Telescope-style notes picker',
        details: 'Same as bare `kra notes` \u2014 launches nvim with the bundled config and opens the Telescope find-files picker rooted at ~/.kra/notes.',
        highlights: [
            'Fuzzy search across every note in the notes root.',
            'Live preview of the highlighted note.',
            'Enter to open in current buffer, splits via the bundled keymaps.',
        ],
    },
};
