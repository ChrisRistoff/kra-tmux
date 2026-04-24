export const TOOLS = [
    {
        name: 'get_outline',
        description: [
            'Returns a structured outline of a source file: function/class/method names and their line numbers.',
            'Use this before reading a large file to understand its structure, then use read_lines or read_function',
            'to fetch only the sections you need. Much cheaper than reading the whole file.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
            },
            required: ['file_path'],
        },
    },

    {
        name: 'read_lines',
        description: [
            'Returns specific lines from a file (1-indexed, inclusive).',
            'Each returned line is prefixed with its line number (e.g. `  267: ...`) so you can pinpoint the exact lines you need for a follow-up `edit_lines` call.',
            'Use this to read only the section you need after checking the outline.',
            'Supports multiple ranges in one call: pass startLines and endLines as parallel arrays (startLines[i] pairs with endLines[i]).',
            'Always prefer the array form over multiple separate calls.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to return (1-indexed). Single-range only.' },
                end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive). Single-range only.' },
                startLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Start lines for multiple ranges. Must be the same length as endLines.',
                },
                endLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'End lines for multiple ranges. Must be the same length as startLines.',
                },
            },
            required: ['file_path'],
        },
    },

    {
        name: 'read_function',
        description: [
            'Returns the full body of a named function, class, or method from a file.',
            'Convenience wrapper — once get_outline gives you start/end lines for TS/JS/Python/Go files, you can just call read_lines directly.',
            'Useful for unknown languages where the outline only has start lines.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                function_name: { type: 'string', description: 'Name of the function, class, or method to return.' },
            },
            required: ['file_path', 'function_name'],
        },
    },

    {
        name: 'edit_lines',
        description: [
            'Replaces a specific line range in a file with new content (1-indexed, inclusive).',
            'Pass new_content as empty string to delete the lines without replacement.',
            'Returns a short summary of what was replaced. The agent already has the old content from its most recent read, so the tool does not echo it back.',
            'Supports multiple edits in one call: pass startLines, endLines, and newContents as parallel arrays.',
            'Always prefer the array form over multiple separate calls.',
            'All line numbers must refer to the ORIGINAL file — the tool sorts ranges internally (largest first) so order does not matter.',
            'No single range may cover more than 100 lines (hard cap, no override of any kind). For larger changes, split into multiple smaller edits — prefer the multi-edit array form so non-overlapping regions all go in one call.',
            'Read-before-edit: every targeted line must have been returned by read_lines or read_function within the current session, otherwise the call is rejected. The cache is reset after each successful edit.',
            'Make MINIMAL, SURGICAL edits: target the SMALLEST possible line range that contains your change. Use the line numbers prefixed in the `read_lines` output to pinpoint the exact lines that must change — do NOT pass the entire range you happened to read just because you read it. If only lines 142–145 need to change inside a 200-line read, edit ONLY 142–145.',
            'Do NOT include unchanged surrounding lines in newContents "for context". Do NOT add or remove unrelated blank lines, do NOT reformat unrelated code, do NOT touch lines outside the scope of your task. Every line inside [start_line, end_line] WILL be replaced verbatim by newContents — unchanged lines in that range are pure waste and a frequent source of accidental edits.',
            'For multiple non-adjacent small changes within one file, prefer several tight ranges in one multi-edit call (e.g. lines 12–12, 47–49, 88–88) over one big range that spans them all.',
            'For near-total file rewrites: split the file into multiple non-overlapping ranges of <=100 lines each and pass them all in one multi-edit call. Do not attempt to bypass the cap.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to replace (1-indexed). Single-edit only.' },
                end_line: { type: 'number', description: 'Last line to replace (1-indexed, inclusive). Single-edit only.' },
                new_content: {
                    type: 'string',
                    description: 'New content to insert in place of the replaced lines. Pass empty string to delete the lines. Single-edit only.',
                },
                startLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Start lines for multiple edits. Must be the same length as endLines and newContents.',
                },
                endLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'End lines for multiple edits. Must be the same length as startLines and newContents.',
                },
                newContents: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Replacement content for each edit. Must be the same length as startLines and endLines.',
                },
            },
            required: ['file_path'],
        },
    },

    {
        name: 'create_file',
        description: [
            'Creates a NEW file with the given content. Refuses if the target path already exists.',
            'To MODIFY an existing file, use edit_lines (use the multi-edit array form for changes spanning multiple regions).',
            'Parent directories are created automatically.',
            'Use this instead of str_replace_editor or write_file for new-file creation.',
            'Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt the destination.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file to create.' },
                content: { type: 'string', description: 'Full content to write to the file.' },
            },
            required: ['file_path', 'content'],
        },
    },

    {
        name: 'search',
        description: [
            'Unified file finder + content grep. Replaces the built-in grep/glob tools.',
            'Provide name_pattern (glob) to filter by file name/path, content_pattern (regex) to search file contents, or both to intersect.',
            'Every result is annotated with the file\'s line count as `path (N lines)` so you can decide whether to read the whole file with read_lines or use get_outline first.',
            'A file under ~100 lines can usually just be read whole — no need for get_outline.',
            'Powered by ripgrep; respects .gitignore by default.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                name_pattern: {
                    type: 'string',
                    description: 'Glob to filter by file name/path (e.g. "**/*.ts", "src/AI/**/auth*"). At least one of name_pattern or content_pattern must be provided.',
                },
                content_pattern: {
                    type: 'string',
                    description: 'Ripgrep regex to search file contents. At least one of name_pattern or content_pattern must be provided.',
                },
                path: {
                    type: 'string',
                    description: 'Optional. Root directory to search from. Defaults to the current working directory.',
                },
                type: {
                    type: 'string',
                    description: 'Optional. Ripgrep --type alias to restrict by language (e.g. "ts", "py", "go").',
                },
                case_insensitive: {
                    type: 'boolean',
                    description: 'Optional. Case-insensitive content match. Default false.',
                },
                context: {
                    type: 'number',
                    description: 'Optional. Lines of context (-C N) around each content match. Ignored unless content_pattern is set. Default 0.',
                },
                multiline: {
                    type: 'boolean',
                    description: 'Optional. Allow content_pattern to match across line boundaries. Ignored unless content_pattern is set. Default false.',
                },
                max_results: {
                    type: 'number',
                    description: 'Optional. Cap on results: file count for name-only searches, match-line count for content searches. Default 50, hard cap 200.',
                },
            },
            required: [],
            anyOf: [
                { required: ['name_pattern'] },
                { required: ['content_pattern'] },
            ],
        },
    },

    {
        name: 'lsp_query',
        description: [
            'Queries a configured Language Server (gopls, pyright, rust-analyzer, ...) about a position in a file.',
            'Use for hover docs, go-to-definition, references, implementations, type definitions, or a flat list of document symbols.',
            'Server is selected automatically by the file extension based on [lsp.*] entries in settings.toml.',
            'Position can be given as (line, col) or (line, symbol) where symbol is searched within that line; both are 1-indexed.',
            'For document_symbols only file_path is required. The first call per language pays a startup + indexing cost.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Absolute or workspace-relative path to the file.',
                },
                op: {
                    type: 'string',
                    enum: ['hover', 'definition', 'references', 'implementation', 'type_definition', 'document_symbols'],
                    description: 'The LSP operation to perform.',
                },
                line: {
                    type: 'number',
                    description: 'Target line (1-indexed). Required for everything except document_symbols.',
                },
                col: {
                    type: 'number',
                    description: 'Target column (1-indexed). Provide either col or symbol.',
                },
                symbol: {
                    type: 'string',
                    description: 'Symbol text to scan for on the target line. Used when col is omitted; resolves to the column of the first occurrence.',
                },
                occurrence: {
                    type: 'number',
                    description: 'Optional. Which occurrence of symbol on the line to use (1-indexed). Default 1.',
                },
                include_declaration: {
                    type: 'boolean',
                    description: 'Optional. references only — include the declaration itself in the results. Default true.',
                },
            },
            required: ['file_path', 'op'],
        },
    },
];

