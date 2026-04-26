export const TOOLS = [
    {
        name: 'get_outline',
        description: [
            'Returns a structured outline of a source file: function/class/method names and their line numbers.',
            'Call this when you need >150 lines of context, want to navigate a file\'s structure, or are picking the smallest range that contains your target.',
            'Then use read_lines or read_function to fetch only the sections you need.',
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
            'You can request any range up to 150 lines directly without calling get_outline first — only larger reads on files with a meaningful outline are bounced back. Truly unstructured files (txt, csv, log, plain markdown without headings, …) are never gated.',
            'Hard cap is 500 lines per call (summed across ranges).',
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
            'Replaces one or more line ranges in a file with new content (1-indexed, inclusive).',
            'ALWAYS uses the array form. Even a single edit is expressed as a 1-element call: startLines: [142], endLines: [145], newContents: ["..."]. There is no single-edit shortcut — start_line/end_line/new_content do not exist.',
            'For multiple non-adjacent changes in the same file, batch them into ONE call as parallel arrays (e.g. startLines: [12, 47, 88]). Do NOT make separate edit_lines calls for each change, and do NOT widen one range to span them.',
            'Pass an empty string in newContents[i] to delete that range without replacement. Returns a short summary of what was replaced; the agent already has the old content from its most recent read, so the tool does not echo it back.',
            'All line numbers refer to the ORIGINAL file — the tool sorts ranges internally (largest first) so order does not matter, and ranges must not overlap.',
            'No single range may cover more than 100 lines (hard cap, no override of any kind). Split larger changes into multiple ranges in the same call.',
            'Read-before-edit: every targeted line must have been returned by read_lines or read_function within the current session, otherwise the call is rejected. The cache is reset for a file after each successful edit.',
            'Make MINIMAL, SURGICAL edits: target the SMALLEST possible line range that contains your change. Use the line numbers prefixed in the `read_lines` output to pinpoint the exact lines. If only lines 142–145 need to change inside a 200-line read, your range is [142, 145] — not [100, 200].',
            'Do NOT include unchanged surrounding lines in newContents "for context". Do NOT add or remove unrelated blank lines, do NOT reformat unrelated code, do NOT touch lines outside the scope of your task. Every line inside [startLines[i], endLines[i]] WILL be replaced verbatim by newContents[i] — unchanged lines in that range are pure waste and a frequent source of accidental edits.',
            'For near-total file rewrites: split the file into multiple non-overlapping ranges of <=100 lines each and pass them all in one call. Do not attempt to bypass the cap.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                startLines: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 1,
                    description: 'First line of each range to replace (1-indexed). For a single edit, pass a 1-element array, e.g. [142]. Must be the same length as endLines and newContents.',
                },
                endLines: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 1,
                    description: 'Last line of each range to replace (1-indexed, inclusive). For a single edit, pass a 1-element array, e.g. [145]. Must be the same length as startLines and newContents.',
                },
                newContents: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    description: 'Replacement content for each range. Pass empty string to delete a range. Must be the same length as startLines and endLines.',
                },
            },
            required: ['file_path', 'startLines', 'endLines', 'newContents'],
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

