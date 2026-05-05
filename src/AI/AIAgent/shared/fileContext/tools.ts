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
            'Each returned line is prefixed with its line number (e.g. `  267: ...`) so you can copy a verbatim slice as the `anchor` for a follow-up `edit` call.',
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
        name: 'anchor_edit',
        description: [
            'Anchor-based file editor. Edits are described by content, never by line numbers.',
            'Each entry in `edits` has an `op` ("replace" | "insert" | "delete") and an `anchor` — one or more contiguous lines copied verbatim from the file that uniquely identify the location. The anchor itself is never altered unless the op is replace/delete and it falls inside the affected range.',
            'replace: removes the anchor block (or the range from `anchor` through `end_anchor` if provided) and writes `content` in its place. Pass content:"" to delete the matched range.',
            'insert: adds `content` adjacent to the anchor. Use position:"after" (default) or position:"before". The anchor is preserved; nothing is overwritten.',
            'delete: removes the anchor block (or the range from `anchor` through `end_anchor` if provided). No `content` field.',
            'Anchors must match EXACTLY ONCE in the file. If your anchor matches zero or multiple lines the call is rejected with hints — extend the anchor with one more adjacent line until it is unique. A blank or whitespace-only anchor is always rejected.',
            'Anchors may span multiple lines (1–5 is typical). For ranges, both `anchor` and `end_anchor` must independently match exactly once and `end_anchor` must be at or after `anchor`. Whitespace is significant; if a strict match fails the tool will retry with whitespace trimmed and accept it iff that produces exactly one match (it will tell you in the response).',
            'Multi-edit: pass several entries in `edits`. All anchors are resolved against the ORIGINAL file in parallel, overlapping or identical regions are rejected, and the edits are applied bottom-to-top so positions stay valid.',
            'The replaced region is always bounded by content you named explicitly, so you cannot accidentally clobber surrounding lines.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                edits: {
                    type: 'array',
                    minItems: 1,
                    description: 'One or more edits to apply atomically. Resolved against the original file in parallel; rejected as a group if any anchor is missing/ambiguous or any two edits overlap.',
                    items: {
                        type: 'object',
                        properties: {
                            op: {
                                type: 'string',
                                enum: ['replace', 'insert', 'delete'],
                                description: '"replace" swaps the anchored region for `content`; "insert" adds `content` next to the anchor without removing it; "delete" removes the anchored region.',
                            },
                            anchor: {
                                type: 'string',
                                description: 'One or more contiguous lines copied verbatim from the file that uniquely identify the edit location. Multiple lines are joined with \\n. Must match exactly once.',
                            },
                            end_anchor: {
                                type: 'string',
                                description: 'Optional. replace/delete only. Upgrades the edit to a range whose end is also content-verified. Must match exactly once and appear at or after `anchor`.',
                            },
                            position: {
                                type: 'string',
                                enum: ['before', 'after'],
                                description: 'Insert only. Whether `content` goes immediately before or after the anchor block. Default "after".',
                            },
                            content: {
                                type: 'string',
                                description: 'Required for replace/insert. The text to write in (replace) or to add (insert). May span multiple lines; do NOT include surrounding context lines that are not actually changing.',
                            },
                        },
                        required: ['op', 'anchor'],
                    },
                },
            },
            required: ['file_path', 'edits'],
        },
    },

    {
        name: 'create_file',
        description: [
            'Creates a NEW file with the given content. Refuses if the target path already exists.',
            'To MODIFY an existing file, use the `edit` tool (anchor-based; pass several entries in `edits` for multiple changes in one call).',
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
            'Use this for exact symbol, literal string, or file/path lookups once you know what token you want to search for.',
            'For conceptual discovery or unfamiliar code paths, prefer `semantic_search` first.',
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

