# 🤖 AI Chat System with Neovim Integration

A sophisticated AI chat interface built on Neovim with advanced file context management, streaming responses, and persistent conversation history.

## ✨ Key Features

- **🖥️ Neovim-Native Interface**: Chat directly within Neovim with intuitive key bindings
- **📁 Smart File Context**: Add entire files or visual selections as context for AI conversations
- **⚡ Real-time Streaming**: Live AI response streaming with user-controlled abort capability
- **🔌 Multi-Provider Support**: Works with various AI model providers and models
- **💾 Persistent Sessions**: Automatic chat saving/loading with intelligent summarization
- **🔄 Tmux Integration**: Seamless tmux split-pane support
- **🎯 Visual Selection**: Select specific code portions using Neovim's visual mode
- **📊 Context Management**: Visual popup interface for managing file contexts

## 🏗️ System Architecture

```mermaid
graph TB
    subgraph "User Interface"
        USER[👤 User]
        NVIM[📝 Neovim Editor]
        TMUX[🖥️ Tmux Session]
    end

    subgraph "Core System"
        CONVERSE[🎯 converse()]
        EVENTS[⚡ Event Handlers]
        SOCKET[🔌 Socket RPC]
        STREAM[📡 Stream Controller]
    end

    subgraph "Context Management"
        FCTX[📁 File Contexts]
        TELESCOPE[🔍 Telescope Picker]
        VISUAL[👁️ Visual Selection]
        FULL[📄 Full Files]
        PARTIAL[✂️ Selections]
    end

    subgraph "AI Pipeline"
        PROMPT[🤖 promptModel()]
        PROVIDER[🏢 AI Provider]
        RESPONSE[📡 Streaming Response]
    end

    subgraph "Persistence"
        CHAT[💬 Chat File]
        HISTORY[📚 Chat History]
        SAVE[💾 saveChat()]
    end

    USER --> NVIM
    NVIM <--> SOCKET
    SOCKET --> EVENTS
    EVENTS --> CONVERSE

    EVENTS --> TELESCOPE
    TELESCOPE --> VISUAL
    VISUAL --> PARTIAL
    TELESCOPE --> FULL
    FULL --> FCTX
    PARTIAL --> FCTX

    EVENTS --> STREAM
    FCTX --> PROMPT
    CHAT --> PROMPT
    PROMPT --> PROVIDER
    PROVIDER --> RESPONSE
    RESPONSE --> STREAM
    STREAM --> NVIM

    NVIM --> CHAT
    CHAT --> SAVE
    SAVE --> HISTORY

    TMUX -.-> NVIM
```

## ⌨️ Key Bindings & Controls

| Key | Action | Description |
|-----|--------|-------------|
| `⏎ Enter` | 🚀 Submit | Send message to AI (normal mode) |
| `@ @` | 📎 Add File | Open Telescope file picker for context |
| `f f` | 📂 Show Contexts | Display popup with active file contexts |
| `r r` | 🗑️ Remove Context | Select and remove file from context |
| `Ctrl+X` | 🧹 Clear All | Remove all file contexts |
| `Ctrl+C` | ⏹️ Stop Stream | Abort AI response generation |
| `Space` | ✂️ Add Selection | Add visual selection to context (visual mode) |

## 📁 File Context System

### 🎯 Context Types

#### 📄 Full File Context
```typescript
// Loads entire file content
{
  filePath: "/path/to/file.js",
  isPartial: false,
  summary: "Full file: file.js (150 lines)"
}
```

#### ✂️ Partial Context (Visual Selection)
```typescript
// User-selected text portions
{
  filePath: "/path/to/file.js",
  isPartial: true,
  startLine: 25,
  endLine: 40,
  summary: "Partial file: file.js (lines 25-40)"
}
```

### 🔄 Context Workflow

1. **📎 File Selection**: Telescope picker shows project files
2. **⚖️ Choice Dialog**: Choose between "entire file" or "partial selection"
3. **✂️ Visual Selection**: For partial - select text in visual mode, press `Space`
4. **💾 Context Storage**: Metadata stored in `fileContexts` array
5. **🤖 AI Integration**: Context automatically included in AI prompts

## 🚀 Core Functions

### `converse()` - Main Orchestrator
```typescript
async function converse(
    chatFile: string,
    temperature: number,
    role: string,
    provider: string,
    model: string,
    isChatLoaded = false
): Promise<void>
```

**Responsibilities:**
- 🏗️ Initialize chat session and file contexts
- 🖥️ Launch Neovim with custom configuration
- 🔌 Set up socket communication
- ⚙️ Configure event handlers and key bindings
- 💾 Manage session lifecycle

### File Context Management

#### `handleAddFileContext()`
- 🔍 Opens Telescope file picker
- ⚖️ Prompts user for context type choice
- 📄 Delegates to full or partial context handlers

#### `addEntireFileContext()`
- 📖 Reads complete file content
- 📊 Calculates file metrics (lines, size)
- 💾 Stores context metadata
- 📝 Appends context summary to chat

#### `addPartialFileContext()`
- 🖥️ Opens file in split window
- 👁️ Enables visual selection mode
- ⏰ Sets up temporary key bindings
- 📡 Uses RPC to capture selection
- 🧹 Cleans up mappings and functions

### Stream Management

#### `StreamController` Interface
```typescript
interface StreamController {
    abort: () => void;
    isAborted: boolean;
}
```

#### `handleStreamingResponse()`
- 📡 Processes async AI response chunks
- ⏱️ Buffers updates for smooth display
- ⏹️ Respects user abort signals
- 🔄 Updates Neovim buffer in real-time

## 💾 Chat Persistence System

### 🗃️ Data Structure
```typescript
interface FileContext {
    filePath: string;
    isPartial: boolean;
    startLine?: number;
    endLine?: number;
    summary: string;
}

interface ChatHistory {
    role: Role;
    message: string;
    timestamp: string;
}
```

### 💬 Chat File Format
```markdown
# AI Chat History

### USER (2024-01-15T10:30:00.000Z)
Hello, can you help me with this code?

📁 utils.js (45 lines, 2KB)
```javascript
// Full file content loaded: /path/to/utils.js
// File contains 45 lines of javascript code
```

### AI - gpt-4 (2024-01-15T10:30:15.000Z)
I'd be happy to help! I can see the utils.js file...
```

### 🔄 Context Reconstruction
The `rebuildFileContextsFromChat()` function parses saved chat files to restore file context state:
- 🔍 Scans for context markers (`📁`)
- 📊 Extracts file paths and line ranges
- 🏗️ Rebuilds `fileContexts` array
- ✅ Validates file accessibility

## 🛡️ Error Handling & Resilience

### 🚫 File Access Errors
- Graceful handling of unreadable files
- Clear error messages in context summaries
- Continuation of chat session despite file errors

### ⏹️ Stream Interruption
- User-controlled abort mechanism
- Clean termination of AI requests
- Status messages for stopped generations

### 🔌 Socket Communication
- Automatic socket path generation
- Connection timeout handling
- Proper cleanup on disconnect

### 🧹 Resource Management
- Temporary key binding cleanup
- Function definition cleanup
- Window management (split/close)

## 🎛️ Configuration & Setup

### 🔑 Key Dependencies
- `neovim`: Node.js Neovim client
- `telescope.nvim`: File picker interface
- Custom AI provider integration
- File system operations (`fs/promises`)

### ⚙️ Environment Integration
```typescript
// Tmux detection and integration
if (process.env.TMUX) {
    // Create tmux split-pane with Neovim
} else {
    // Launch standalone Neovim instance
}
```

### 🎨 Neovim Configuration
- Custom commands registered via RPC
- Syntax highlighting for code blocks
- Buffer-specific key mappings
- Popup window styling

## 🔄 Session Lifecycle

1. **🚀 Initialization**
   - Create temporary chat file
   - Clear existing file contexts
   - Initialize chat header with controls

2. **🖥️ Neovim Launch**
   - Generate unique socket path
   - Launch Neovim with custom config
   - Wait for socket connection

3. **⚙️ Configuration**
   - Register RPC commands
   - Set up key bindings
   - Configure event handlers

4. **💬 Interactive Session**
   - User types messages and manages contexts
   - Real-time AI responses with streaming
   - Dynamic context management

5. **💾 Cleanup & Save**
   - Parse conversation history
   - Save chat with metadata
   - Clean up temporary files
   - Close socket connection

## 🎯 Advanced Features

### 🔍 Smart Context Display
- Full file contexts show summary only in chat
- Partial contexts display actual selected text
- Syntax highlighting based on file extension
- File size and line count metrics

### 📊 Visual Management
- Popup interface for context overview
- One-click context removal
- Real-time context status display
- Error indicators for inaccessible files

### ⚡ Performance Optimizations
- Buffered streaming updates
- Efficient file reading
- Minimal Neovim redraws
- Context caching during session

This system provides a powerful, developer-friendly interface for AI-assisted coding and conversation, seamlessly integrating file context management with the familiar Neovim editing environment.
