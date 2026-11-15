// Data Storage
const STORAGE_TASKS = 'notemaker_tasks';
const STORAGE_NOTES = 'notemaker_notes';

// State
let currentDate = new Date().toISOString().split('T')[0];
let tasks = loadTasks();
let notes = loadNotes();

// Undo/Redo History
let taskHistory = [];
let taskHistoryIndex = -1;
let noteHistory = [];
let noteHistoryIndex = -1;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Set today's date
    document.getElementById('datePicker').value = currentDate;
    
    // Event listeners
    document.getElementById('datePicker').addEventListener('change', (e) => {
        currentDate = e.target.value;
        renderTasks();
        loadNoteForDate();
        updateStats();
        updateForwardButton();
    });
    
    document.getElementById('prevDay').addEventListener('click', () => {
        moveDate(-1);
    });
    
    document.getElementById('nextDay').addEventListener('click', () => {
        moveDate(1);
    });
    
    document.getElementById('todayBtn').addEventListener('click', () => {
        currentDate = new Date().toISOString().split('T')[0];
        document.getElementById('datePicker').value = currentDate;
        renderTasks();
        loadNoteForDate();
        updateStats();
        updateForwardButton();
    });
    
    document.getElementById('taskFilter').addEventListener('change', () => {
        renderTasks();
    });
    
    document.getElementById('forwardTasks').addEventListener('click', () => {
        forwardIncompleteTasks();
    });
    
    // Export/Import
    document.getElementById('exportBtn').addEventListener('click', () => {
        exportData();
    });
    
    document.getElementById('importBtn').addEventListener('click', () => {
        document.getElementById('importFile').click();
    });
    
    document.getElementById('importFile').addEventListener('change', (e) => {
        importData(e.target.files[0]);
    });
    
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });
    
    // Notes editor - single markdown editor with edit/lock toggle
    const notesEditorMd = document.getElementById('notesEditorMd');
    const notesPreview = document.getElementById('notesPreview');
    const editToggleBtn = document.getElementById('editToggleBtn');
    const saveBtn = document.getElementById('saveBtn');
    let isEditing = false;
    let syncScrollEnabled = true;
    
    // Edit/Lock toggle
    editToggleBtn.addEventListener('click', () => {
        if (!isEditing) {
            enableEditing();
        }
    });
    
    saveBtn.addEventListener('click', () => {
        saveAndLock();
    });
    
    // Markdown editor input - live preview
    notesEditorMd.addEventListener('input', () => {
        if (isEditing) {
            saveToNoteHistory();
            updatePreview(notesEditorMd.value);
            syncScrollIfEnabled();
        }
    });
    
    // Smart Enter key for lists
    notesEditorMd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && isEditing) {
            handleSmartEnter(e);
        }
        
        // Undo/Redo with Ctrl+Z and Ctrl+Shift+Z
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undoNote();
            } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
                e.preventDefault();
                redoNote();
            }
        }
    });
    
    // Undo/Redo buttons
    document.getElementById('undoBtn').addEventListener('click', () => undoNote());
    document.getElementById('redoBtn').addEventListener('click', () => redoNote());
    
    // Sync scroll
    document.getElementById('syncScroll').addEventListener('change', (e) => {
        syncScrollEnabled = e.target.checked;
    });
    
    notesEditorMd.addEventListener('scroll', () => {
        if (syncScrollEnabled && isEditing) {
            syncScroll();
        }
    });
    
    notesPreview.addEventListener('scroll', () => {
        if (syncScrollEnabled && isEditing) {
            syncScrollPreview();
        }
    });
    
    // Formatting buttons
    document.getElementById('boldBtn').addEventListener('click', () => insertMarkdown('**', '**'));
    document.getElementById('italicBtn').addEventListener('click', () => insertMarkdown('*', '*'));
    document.getElementById('codeBtn').addEventListener('click', () => insertMarkdown('`', '`'));
    document.getElementById('linkBtn').addEventListener('click', () => insertMarkdown('[', '](url)'));
    document.getElementById('imageBtn').addEventListener('click', () => insertMarkdown('![', '](url)'));
    document.getElementById('h1Btn').addEventListener('click', () => insertMarkdownLine('# '));
    document.getElementById('h2Btn').addEventListener('click', () => insertMarkdownLine('## '));
    document.getElementById('h3Btn').addEventListener('click', () => insertMarkdownLine('### '));
    document.getElementById('ulBtn').addEventListener('click', () => insertMarkdownLine('- '));
    document.getElementById('olBtn').addEventListener('click', () => insertMarkdownLine('1. '));
    document.getElementById('blockquoteBtn').addEventListener('click', () => insertMarkdownLine('> '));
    document.getElementById('hrBtn').addEventListener('click', () => insertMarkdownLine('\n---\n'));
    document.getElementById('tableBtn').addEventListener('click', () => insertTable());
    document.getElementById('indentBtn').addEventListener('click', () => indentMarkdown());
    document.getElementById('outdentBtn').addEventListener('click', () => outdentMarkdown());
    
    function enableEditing() {
        isEditing = true;
        const editorWrapper = document.getElementById('editorWrapper');
        const previewOnly = document.getElementById('notesPreviewOnly');
        
        // Show editor, hide preview-only
        editorWrapper.style.display = 'grid';
        previewOnly.style.display = 'none';
        
        notesEditorMd.readOnly = false;
        notesEditorMd.classList.add('editing');
        editToggleBtn.style.display = 'none';
        saveBtn.style.display = 'inline-block';
        notesEditorMd.focus();
        updatePreview(notesEditorMd.value);
        
        // Initialize note history
        saveToNoteHistory();
    }
    
    function saveAndLock() {
        isEditing = false;
        const content = notesEditorMd.value;
        saveNoteForDate(content);
        
        const editorWrapper = document.getElementById('editorWrapper');
        const previewOnly = document.getElementById('notesPreviewOnly');
        const previewContent = document.getElementById('notesPreviewContent');
        
        // Hide editor, show preview-only
        editorWrapper.style.display = 'none';
        previewOnly.style.display = 'block';
        
        // Update preview content
        previewContent.innerHTML = markdownToHtml(content);
        
        notesEditorMd.readOnly = true;
        notesEditorMd.classList.remove('editing');
        editToggleBtn.style.display = 'inline-block';
        saveBtn.style.display = 'none';
    }
    
    function syncScroll() {
        const ratio = notesEditorMd.scrollTop / (notesEditorMd.scrollHeight - notesEditorMd.clientHeight);
        notesPreview.scrollTop = ratio * (notesPreview.scrollHeight - notesPreview.clientHeight);
    }
    
    function syncScrollPreview() {
        const ratio = notesPreview.scrollTop / (notesPreview.scrollHeight - notesPreview.clientHeight);
        notesEditorMd.scrollTop = ratio * (notesEditorMd.scrollHeight - notesEditorMd.clientHeight);
    }
    
    function syncScrollIfEnabled() {
        if (syncScrollEnabled) {
            setTimeout(syncScroll, 10);
        }
    }
    
    function insertMarkdown(before, after) {
        if (!isEditing) return;
        const start = notesEditorMd.selectionStart;
        const end = notesEditorMd.selectionEnd;
        const text = notesEditorMd.value;
        const selectedText = text.substring(start, end);
        const newText = text.substring(0, start) + before + selectedText + after + text.substring(end);
        notesEditorMd.value = newText;
        notesEditorMd.setSelectionRange(start + before.length, end + before.length);
        notesEditorMd.focus();
        updatePreview(newText);
    }
    
    function insertMarkdownLine(prefix) {
        if (!isEditing) return;
        const start = notesEditorMd.selectionStart;
        const text = notesEditorMd.value;
        const lines = text.substring(0, start).split('\n');
        const currentLine = lines.length - 1;
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = text.indexOf('\n', start);
        const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
        const newLine = prefix + line;
        const newText = text.substring(0, lineStart) + newLine + text.substring(lineEnd === -1 ? text.length : lineEnd);
        notesEditorMd.value = newText;
        notesEditorMd.setSelectionRange(lineStart + prefix.length + line.length, lineStart + prefix.length + line.length);
        notesEditorMd.focus();
        updatePreview(newText);
    }
    
    function insertTable() {
        if (!isEditing) return;
        const table = '\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |\n';
        insertMarkdown('', table);
    }
    
    // Theme switching
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.theme;
            switchTheme(theme);
        });
    });
    
    // Load saved theme
    const savedTheme = localStorage.getItem('notemaker_theme') || 'ocean';
    switchTheme(savedTheme);
    
    // Task Undo/Redo buttons
    document.getElementById('undoTaskBtn').addEventListener('click', () => undoTasks());
    document.getElementById('redoTaskBtn').addEventListener('click', () => redoTasks());
    
    // Task Undo/Redo keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            // Check if we're in tasks tab
            const tasksTab = document.getElementById('tasksTab');
            if (tasksTab && tasksTab.classList.contains('active')) {
                e.preventDefault();
                undoTasks();
            }
        } else if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
            const tasksTab = document.getElementById('tasksTab');
            if (tasksTab && tasksTab.classList.contains('active')) {
                e.preventDefault();
                redoTasks();
            }
        }
    });
    
    // Initial render
    renderTasks();
    loadNoteForDate();
    updateStats();
    updateForwardButton();
    
    // Initialize history
    saveToTaskHistory();
    saveToNoteHistory();
}

// Task Management
function addTask() {
    const input = document.getElementById('newTaskInput');
    const title = input.value.trim();
    
    if (!title) return;
    
    const task = {
        id: Date.now().toString(),
        title: title,
        date: currentDate,
        completed: false,
        createdAt: new Date().toISOString(),
        subtasks: []
    };
    
    tasks.push(task);
    saveTasks();
    input.value = '';
    renderTasks();
    updateStats();
    updateForwardButton();
}

function addSubtask(taskId) {
    saveToTaskHistory();
    const input = document.getElementById(`subtask-input-${taskId}`);
    const title = input.value.trim();
    
    if (!title) return;
    
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    if (!task.subtasks) {
        task.subtasks = [];
    }
    
    const subtask = {
        id: Date.now().toString() + Math.random(),
        title: title,
        completed: false
    };
    
    task.subtasks.push(subtask);
    saveTasks();
    input.value = '';
    
    // Keep subtasks container open after adding
    const container = document.getElementById(`subtasks-${taskId}`);
    const wasOpen = container && container.style.display !== 'none';
    
    renderTasks();
    updateStats();
    
    // Re-open the subtasks container if it was open
    if (wasOpen) {
        const newContainer = document.getElementById(`subtasks-${taskId}`);
        if (newContainer) {
            newContainer.style.display = 'block';
            // Focus on the input field
            const newInput = document.getElementById(`subtask-input-${taskId}`);
            if (newInput) {
                setTimeout(() => newInput.focus(), 100);
            }
        }
    }
}

function toggleSubtask(taskId, subtaskId) {
    saveToTaskHistory();
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.subtasks) return;
    
    const subtask = task.subtasks.find(s => s.id === subtaskId);
    if (subtask) {
        subtask.completed = !subtask.completed;
        saveTasks();
        renderTasks();
        updateStats();
    }
}

function deleteSubtask(taskId, subtaskId) {
    saveToTaskHistory();
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.subtasks) return;
    
    task.subtasks = task.subtasks.filter(s => s.id !== subtaskId);
    saveTasks();
    renderTasks();
    updateStats();
}

function toggleSubtasks(taskId) {
    const container = document.getElementById(`subtasks-${taskId}`);
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

function toggleTask(taskId) {
    saveToTaskHistory();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
        task.completed = !task.completed;
        saveTasks();
        renderTasks();
        updateStats();
        updateForwardButton();
    }
}

function deleteTask(taskId) {
    saveToTaskHistory();
    tasks = tasks.filter(t => t.id !== taskId);
    saveTasks();
    renderTasks();
    updateStats();
    updateForwardButton();
}

function renderTasks() {
    const filter = document.getElementById('taskFilter').value;
    const dateTasks = tasks.filter(t => t.date === currentDate);
    
    let filteredTasks = dateTasks;
    if (filter === 'completed') {
        filteredTasks = dateTasks.filter(t => t.completed);
    } else if (filter === 'incomplete') {
        filteredTasks = dateTasks.filter(t => !t.completed);
    }
    
    const tasksList = document.getElementById('tasksList');
    const emptyState = document.getElementById('emptyState');
    
    if (filteredTasks.length === 0) {
        tasksList.style.display = 'none';
        emptyState.style.display = 'flex';
        emptyState.querySelector('p').textContent = 
            filter === 'all' ? 'No tasks for this date' : 
            filter === 'completed' ? 'No completed tasks' : 
            'No incomplete tasks';
    } else {
        tasksList.style.display = 'flex';
        emptyState.style.display = 'none';
        
        tasksList.innerHTML = filteredTasks.map(task => {
            const subtasks = task.subtasks || [];
            const completedSubtasks = subtasks.filter(s => s.completed).length;
            const hasSubtasks = subtasks.length > 0;
            
            return `
            <div class="task-item-wrapper">
                <div class="task-item ${task.completed ? 'completed' : ''}" onclick="event.stopPropagation(); toggleTask('${task.id}')">
                    <div class="task-checkbox ${task.completed ? 'checked' : ''}"></div>
                    <div class="task-text">${escapeHtml(task.title)}</div>
                    <div class="task-actions">
                        <button class="task-subtask-btn" onclick="event.stopPropagation(); toggleSubtasks('${task.id}')" title="Toggle Subtasks">
                            📋 ${hasSubtasks ? `(${completedSubtasks}/${subtasks.length})` : ''}
                        </button>
                        <button class="task-delete" onclick="event.stopPropagation(); deleteTask('${task.id}')">Delete</button>
                    </div>
                </div>
                <div class="subtasks-container" id="subtasks-${task.id}" style="display: none;">
                    <div class="subtasks-list">
                        ${subtasks.map(subtask => `
                            <div class="subtask-item ${subtask.completed ? 'completed' : ''}" onclick="event.stopPropagation(); toggleSubtask('${task.id}', '${subtask.id}')">
                                <div class="subtask-checkbox ${subtask.completed ? 'checked' : ''}"></div>
                                <div class="subtask-text">${escapeHtml(subtask.title)}</div>
                                <button class="subtask-delete" onclick="event.stopPropagation(); deleteSubtask('${task.id}', '${subtask.id}')">×</button>
                            </div>
                        `).join('')}
                    </div>
                    <div class="add-subtask-section">
                        <input 
                            type="text" 
                            id="subtask-input-${task.id}" 
                            class="subtask-input" 
                            placeholder="Add subtask..."
                            onkeypress="if(event.key === 'Enter') addSubtask('${task.id}')"
                            onclick="event.stopPropagation()"
                        >
                        <button class="add-subtask-btn" onclick="event.stopPropagation(); addSubtask('${task.id}')">+</button>
                    </div>
                </div>
            </div>
            `;
        }).join('');
    }
}

function forwardIncompleteTasks() {
    const today = currentDate;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    
    const incompleteTasks = tasks.filter(t => 
        t.date === today && !t.completed
    );
    
    if (incompleteTasks.length === 0) {
        alert('No incomplete tasks to forward!');
        return;
    }
    
    if (confirm(`Forward ${incompleteTasks.length} incomplete task(s) to tomorrow?`)) {
        incompleteTasks.forEach(task => {
            task.date = tomorrowStr;
            task.completed = false;
            // Ensure subtasks array exists
            if (!task.subtasks) {
                task.subtasks = [];
            }
            // Incomplete subtasks remain incomplete (already handled)
        });
        
        saveTasks();
        renderTasks();
        updateStats();
        updateForwardButton();
        
        alert(`Forwarded ${incompleteTasks.length} task(s) to ${formatDate(tomorrowStr)}`);
    }
}

// Notes Management
function loadNoteForDate() {
    const note = notes.find(n => n.date === currentDate);
    const content = note ? note.content : '';
    const editorMd = document.getElementById('notesEditorMd');
    const editorWrapper = document.getElementById('editorWrapper');
    const previewOnly = document.getElementById('notesPreviewOnly');
    const previewContent = document.getElementById('notesPreviewContent');
    
    // Load markdown content
    editorMd.value = content;
    
    // Always show preview-only by default (locked state)
    editorWrapper.style.display = 'none';
    previewOnly.style.display = 'block';
    previewContent.innerHTML = markdownToHtml(content);
    
    // Reset to locked state
    isEditing = false;
    editToggleBtn.style.display = 'inline-block';
    saveBtn.style.display = 'none';
}

function updatePreview(markdown) {
    const preview = document.getElementById('notesPreview');
    preview.innerHTML = markdownToHtml(markdown);
}

function htmlToMarkdown(html) {
    if (!html) return '';
    
    let md = html;
    
    // Headers
    md = md.replace(/<h1>(.*?)<\/h1>/gi, '# $1\n');
    md = md.replace(/<h2>(.*?)<\/h2>/gi, '## $1\n');
    md = md.replace(/<h3>(.*?)<\/h3>/gi, '### $1\n');
    
    // Bold
    md = md.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');
    md = md.replace(/<b>(.*?)<\/b>/gi, '**$1**');
    
    // Italic
    md = md.replace(/<em>(.*?)<\/em>/gi, '*$1*');
    md = md.replace(/<i>(.*?)<\/i>/gi, '*$1*');
    
    // Underline
    md = md.replace(/<u>(.*?)<\/u>/gi, '~~$1~~');
    
    // Code
    md = md.replace(/<code>(.*?)<\/code>/gi, '`$1`');
    
    // Lists
    md = md.replace(/<ul[^>]*>/gi, '');
    md = md.replace(/<\/ul>/gi, '\n');
    md = md.replace(/<ol[^>]*>/gi, '');
    md = md.replace(/<\/ol>/gi, '\n');
    md = md.replace(/<li>(.*?)<\/li>/gi, '- $1\n');
    
    // Paragraphs
    md = md.replace(/<p>(.*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<div>(.*?)<\/div>/gi, '$1\n');
    
    // Remove remaining HTML tags
    md = md.replace(/<[^>]+>/g, '');
    
    // Clean up multiple newlines
    md = md.replace(/\n{3,}/g, '\n\n');
    md = md.trim();
    
    return md;
}

function saveNoteForDate(content) {
    const existingIndex = notes.findIndex(n => n.date === currentDate);
    
    if (existingIndex >= 0) {
        notes[existingIndex].content = content;
    } else {
        notes.push({
            date: currentDate,
            content: content,
            createdAt: new Date().toISOString()
        });
    }
    
    saveNotes();
}

// Markdown Functions - Both editors are always visible now

function markdownToHtml(markdown) {
    if (!markdown) return '';
    
    let html = markdown;
    
    // Code blocks (must be processed first)
    html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
        return '<pre><code>' + escapeHtml(code.trim()) + '</code></pre>';
    });
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Headers
    html = html.replace(/^###### (.*$)/gim, '<h6>$1</h6>');
    html = html.replace(/^##### (.*$)/gim, '<h5>$1</h5>');
    html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    
    // Horizontal rule
    html = html.replace(/^---$/gim, '<hr>');
    html = html.replace(/^\*\*\*$/gim, '<hr>');
    html = html.replace(/^___$/gim, '<hr>');
    
    // Blockquotes
    html = html.replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>');
    html = html.replace(/<\/blockquote>\s*<blockquote>/g, '<br>');
    
    // Tables
    html = html.replace(/\|(.+)\|/g, (match, content) => {
        const cells = content.split('|').map(cell => cell.trim()).filter(cell => cell);
        if (cells.length === 0) return '';
        
        // Check if it's a header separator
        if (cells.every(cell => /^:?-+:?$/.test(cell))) {
            return '';
        }
        
        const isHeader = html.indexOf(match) < html.indexOf('\n---\n') || 
                         html.split('\n').indexOf(match) === 0;
        const tag = isHeader ? 'th' : 'td';
        return '<tr>' + cells.map(cell => `<${tag}>${cell}</${tag}>`).join('') + '</tr>';
    });
    html = html.replace(/(<tr>.*<\/tr>)/gs, '<table>$1</table>');
    
    // Images
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
    
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.*?)_/g, '<em>$1</em>');
    
    // Strikethrough
    html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');
    
    // Lists (handle nested lists)
    html = html.split('\n');
    let inList = false;
    let listType = null;
    let listDepth = 0;
    let result = [];
    
    for (let i = 0; i < html.length; i++) {
        const line = html[i];
        const unorderedMatch = line.match(/^(\s*)[-*+] (.+)$/);
        const orderedMatch = line.match(/^(\s*)\d+\. (.+)$/);
        
        if (unorderedMatch) {
            const depth = Math.floor(unorderedMatch[1].length / 2);
            const content = unorderedMatch[2];
            
            if (!inList || listType !== 'ul' || depth !== listDepth) {
                if (inList && depth < listDepth) {
                    for (let j = listDepth; j > depth; j--) {
                        result.push('</ul>');
                    }
                } else if (inList && depth > listDepth) {
                    result.push('<ul>');
                } else if (!inList) {
                    result.push('<ul>');
                }
                inList = true;
                listType = 'ul';
                listDepth = depth;
            }
            result.push(`<li>${content}</li>`);
        } else if (orderedMatch) {
            const depth = Math.floor(orderedMatch[1].length / 2);
            const content = orderedMatch[2];
            
            if (!inList || listType !== 'ol' || depth !== listDepth) {
                if (inList && depth < listDepth) {
                    for (let j = listDepth; j > depth; j--) {
                        result.push(listType === 'ul' ? '</ul>' : '</ol>');
                    }
                } else if (inList && depth > listDepth) {
                    result.push('<ol>');
                } else if (!inList) {
                    result.push('<ol>');
                }
                inList = true;
                listType = 'ol';
                listDepth = depth;
            }
            result.push(`<li>${content}</li>`);
        } else {
            if (inList) {
                for (let j = listDepth; j >= 0; j--) {
                    result.push(listType === 'ul' ? '</ul>' : '</ol>');
                }
                inList = false;
                listType = null;
                listDepth = 0;
            }
            if (line.trim() && !line.match(/^<[^>]+>$/)) {
                result.push(`<p>${line}</p>`);
            } else if (!line.trim()) {
                result.push('<br>');
            } else {
                result.push(line);
            }
        }
    }
    
    if (inList) {
        for (let j = listDepth; j >= 0; j--) {
            result.push(listType === 'ul' ? '</ul>' : '</ol>');
        }
    }
    
    html = result.join('\n');
    
    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<[^>]+>)<\/p>/g, '$1');
    
    return html;
}

function indentMarkdown() {
    const editor = document.getElementById('notesEditorMd');
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = editor.value;
    const lines = text.substring(0, start).split('\n');
    const currentLine = lines.length - 1;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    
    // Get current line
    const lineEnd = text.indexOf('\n', start);
    const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
    
    // Check if it's a list item
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
        const indent = listMatch[1];
        const marker = listMatch[2];
        const content = listMatch[3];
        const newIndent = indent + '  ';
        const newLine = newIndent + marker + ' ' + content;
        
        editor.value = text.substring(0, lineStart) + newLine + text.substring(lineEnd === -1 ? text.length : lineEnd);
        editor.setSelectionRange(start + 2, end + 2);
        editor.dispatchEvent(new Event('input'));
    }
}

function outdentMarkdown() {
    const editor = document.getElementById('notesEditorMd');
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = editor.value;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', start);
    const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
    
    // Check if it's a list item with indent
    const listMatch = line.match(/^(\s{2,})([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
        const indent = listMatch[1];
        const marker = listMatch[2];
        const content = listMatch[3];
        const newIndent = indent.substring(2);
        const newLine = newIndent + marker + ' ' + content;
        
        editor.value = text.substring(0, lineStart) + newLine + text.substring(lineEnd === -1 ? text.length : lineEnd);
        editor.setSelectionRange(Math.max(0, start - 2), Math.max(0, end - 2));
        editor.dispatchEvent(new Event('input'));
    }
}

// Smart Enter Key Handler
function handleSmartEnter(e) {
    const editor = document.getElementById('notesEditorMd');
    const start = editor.selectionStart;
    const text = editor.value;
    
    // Get the current line
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', start);
    const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
    
    // Check for numbered list (e.g., "1. Hai")
    const numberedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
        e.preventDefault();
        const indent = numberedMatch[1];
        const currentNum = parseInt(numberedMatch[2]);
        const content = numberedMatch[3];
        
        // Always create next numbered item
        const newLine = indent + (currentNum + 1) + '. ';
        const beforeText = text.substring(0, lineEnd === -1 ? text.length : lineEnd);
        const afterText = text.substring(lineEnd === -1 ? text.length : lineEnd);
        const newText = beforeText + '\n' + newLine + afterText;
        
        editor.value = newText;
        const newPos = beforeText.length + 1 + newLine.length;
        editor.setSelectionRange(newPos, newPos);
        editor.dispatchEvent(new Event('input'));
        return true;
    }
    
    // Check for bullet list (e.g., "- item" or "* item")
    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
        e.preventDefault();
        const indent = bulletMatch[1];
        const marker = bulletMatch[2];
        const content = bulletMatch[3];
        
        // Always create next bullet item
        const newLine = indent + marker + ' ';
        const beforeText = text.substring(0, lineEnd === -1 ? text.length : lineEnd);
        const afterText = text.substring(lineEnd === -1 ? text.length : lineEnd);
        const newText = beforeText + '\n' + newLine + afterText;
        
        editor.value = newText;
        const newPos = beforeText.length + 1 + newLine.length;
        editor.setSelectionRange(newPos, newPos);
        editor.dispatchEvent(new Event('input'));
        return true;
    }
    
    return false;
}

// Undo/Redo Functions for Tasks
function saveToTaskHistory() {
    const state = JSON.parse(JSON.stringify(tasks));
    taskHistory = taskHistory.slice(0, taskHistoryIndex + 1);
    taskHistory.push(state);
    taskHistoryIndex = taskHistory.length - 1;
    
    // Limit history to 50 states
    if (taskHistory.length > 50) {
        taskHistory.shift();
        taskHistoryIndex--;
    }
}

function undoTasks() {
    if (taskHistoryIndex > 0) {
        taskHistoryIndex--;
        tasks = JSON.parse(JSON.stringify(taskHistory[taskHistoryIndex]));
        saveTasks();
        renderTasks();
        updateStats();
        updateForwardButton();
    }
}

function redoTasks() {
    if (taskHistoryIndex < taskHistory.length - 1) {
        taskHistoryIndex++;
        tasks = JSON.parse(JSON.stringify(taskHistory[taskHistoryIndex]));
        saveTasks();
        renderTasks();
        updateStats();
        updateForwardButton();
    }
}

// Undo/Redo Functions for Notes
function saveToNoteHistory() {
    if (!isEditing) return;
    const content = document.getElementById('notesEditorMd').value;
    noteHistory = noteHistory.slice(0, noteHistoryIndex + 1);
    noteHistory.push(content);
    noteHistoryIndex = noteHistory.length - 1;
    
    // Limit history to 50 states
    if (noteHistory.length > 50) {
        noteHistory.shift();
        noteHistoryIndex--;
    }
}

function undoNote() {
    if (!isEditing || noteHistoryIndex <= 0) return;
    noteHistoryIndex--;
    const editor = document.getElementById('notesEditorMd');
    editor.value = noteHistory[noteHistoryIndex];
    updatePreview(editor.value);
    editor.focus();
}

function redoNote() {
    if (!isEditing || noteHistoryIndex >= noteHistory.length - 1) return;
    noteHistoryIndex++;
    const editor = document.getElementById('notesEditorMd');
    editor.value = noteHistory[noteHistoryIndex];
    updatePreview(editor.value);
    editor.focus();
}

// Date Management
function moveDate(days) {
    const date = new Date(currentDate);
    date.setDate(date.getDate() + days);
    currentDate = date.toISOString().split('T')[0];
    document.getElementById('datePicker').value = currentDate;
    renderTasks();
    loadNoteForDate();
    updateStats();
    updateForwardButton();
}

// Stats
function updateStats() {
    const dateTasks = tasks.filter(t => t.date === currentDate);
    const completed = dateTasks.filter(t => t.completed).length;
    const remaining = dateTasks.filter(t => !t.completed).length;
    
    // Count subtasks
    let totalSubtasks = 0;
    let completedSubtasks = 0;
    dateTasks.forEach(task => {
        if (task.subtasks && task.subtasks.length > 0) {
            totalSubtasks += task.subtasks.length;
            completedSubtasks += task.subtasks.filter(s => s.completed).length;
        }
    });
    
    document.getElementById('totalTasks').textContent = dateTasks.length;
    document.getElementById('completedTasks').textContent = completed;
    document.getElementById('remainingTasks').textContent = remaining;
    
    // Update with subtask info if available
    const statsSection = document.querySelector('.stats');
    let subtaskStatsEl = document.getElementById('subtaskStats');
    
    if (totalSubtasks > 0) {
        if (!subtaskStatsEl) {
            subtaskStatsEl = document.createElement('div');
            subtaskStatsEl.id = 'subtaskStats';
            subtaskStatsEl.className = 'stat-item';
            statsSection.appendChild(subtaskStatsEl);
        }
        subtaskStatsEl.innerHTML = `<span>Subtasks:</span><span>${completedSubtasks}/${totalSubtasks}</span>`;
    } else if (subtaskStatsEl) {
        subtaskStatsEl.remove();
    }
}

function updateForwardButton() {
    const incompleteTasks = tasks.filter(t => 
        t.date === currentDate && !t.completed
    );
    
    const forwardBtn = document.getElementById('forwardTasks');
    if (incompleteTasks.length > 0) {
        forwardBtn.style.display = 'block';
    } else {
        forwardBtn.style.display = 'none';
    }
}

// Tab Management
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`${tab}Tab`).classList.add('active');
}

// Storage
function loadTasks() {
    const stored = localStorage.getItem(STORAGE_TASKS);
    return stored ? JSON.parse(stored) : [];
}

function saveTasks() {
    localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
}

function loadNotes() {
    const stored = localStorage.getItem(STORAGE_NOTES);
    return stored ? JSON.parse(stored) : [];
}

function saveNotes() {
    localStorage.setItem(STORAGE_NOTES, JSON.stringify(notes));
}

// Export/Import Functions
function exportData() {
    const data = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        tasks: tasks,
        notes: notes
    };
    
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notemaker_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert('✅ Data exported successfully!\n\nFile saved as: notemaker_backup_[date].json');
}

function importData(file) {
    if (!file) return;
    
    if (!file.name.endsWith('.json')) {
        alert('❌ Error: Please select a valid JSON file.');
        return;
    }
    
    const reader = new FileReader();
    
    reader.onload = (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            
            // Validate data structure
            if (!importedData.tasks || !importedData.notes) {
                throw new Error('Invalid data format');
            }
            
            const importedTasks = Array.isArray(importedData.tasks) ? importedData.tasks : [];
            const importedNotes = Array.isArray(importedData.notes) ? importedData.notes : [];
            
            // Calculate what will be added (excluding duplicates)
            // For tasks: check by ID first, then by title+date (semantic duplicate)
            const existingTaskIds = new Set(tasks.map(t => t.id));
            const existingTaskKeys = new Set(tasks.map(t => `${t.date}|${t.title.trim().toLowerCase()}`));
            
            const newTasks = importedTasks.filter(t => {
                // Skip if same ID exists
                if (existingTaskIds.has(t.id)) return false;
                // Skip if same title and date exists (semantic duplicate)
                const taskKey = `${t.date}|${t.title.trim().toLowerCase()}`;
                return !existingTaskKeys.has(taskKey);
            });
            
            // Ensure all imported tasks have subtasks array
            importedTasks.forEach(task => {
                if (!task.subtasks) {
                    task.subtasks = [];
                }
            });
            
            // For notes: check by date+content (exact duplicate)
            const existingNoteKeys = new Set(notes.map(n => `${n.date}|${n.content.trim()}`));
            const newNotes = importedNotes.filter(n => {
                const noteKey = `${n.date}|${n.content.trim()}`;
                return !existingNoteKeys.has(noteKey);
            });
            
            // Confirm import
            const confirmMessage = `This will merge imported data with your existing data.\n\n` +
                `Current data:\n` +
                `- Tasks: ${tasks.length}\n` +
                `- Notes: ${notes.length}\n\n` +
                `Imported data:\n` +
                `- Tasks: ${importedTasks.length} (${newTasks.length} new, ${importedTasks.length - newTasks.length} duplicates)\n` +
                `- Notes: ${importedNotes.length} (${newNotes.length} new, ${importedNotes.length - newNotes.length} duplicates)\n\n` +
                `Export date: ${importedData.exportDate ? new Date(importedData.exportDate).toLocaleString() : 'Unknown'}\n\n` +
                `Do you want to continue?`;
            
            if (confirm(confirmMessage)) {
                // Merge tasks (add new ones, keep existing)
                // Check duplicates by ID and by title+date (semantic duplicate)
                const mergedTaskIds = new Set(tasks.map(t => t.id));
                const mergedTaskKeys = new Set(tasks.map(t => `${t.date}|${t.title.trim().toLowerCase()}`));
                
                importedTasks.forEach(task => {
                    // Skip if same ID exists
                    if (mergedTaskIds.has(task.id)) return;
                    
                    // Skip if same title and date exists (semantic duplicate)
                    const taskKey = `${task.date}|${task.title.trim().toLowerCase()}`;
                    if (mergedTaskKeys.has(taskKey)) return;
                    
                    // Add new task
                    tasks.push(task);
                    mergedTaskIds.add(task.id);
                    mergedTaskKeys.add(taskKey);
                });
                
                // Merge notes (update existing by date or add new)
                importedNotes.forEach(importedNote => {
                    const existingNoteIndex = notes.findIndex(n => n.date === importedNote.date);
                    if (existingNoteIndex >= 0) {
                        // Merge note content if different
                        const existingNote = notes[existingNoteIndex];
                        if (existingNote.content !== importedNote.content) {
                            // Combine both notes with separator
                            notes[existingNoteIndex].content = 
                                existingNote.content.trim() + 
                                (existingNote.content.trim() ? '\n\n--- Merged from import ---\n\n' : '') +
                                importedNote.content.trim();
                        }
                    } else {
                        // Add new note
                        notes.push(importedNote);
                    }
                });
                
                // Save to localStorage
                saveTasks();
                saveNotes();
                
                // Refresh UI
                renderTasks();
                loadNoteForDate();
                updateStats();
                updateForwardButton();
                
                // Reset file input
                document.getElementById('importFile').value = '';
                
                alert(`✅ Data imported successfully!\n\n` +
                    `- ${newTasks.length} new tasks added (${importedTasks.length - newTasks.length} duplicates skipped)\n` +
                    `- ${newNotes.length} new notes added (${importedNotes.length - newNotes.length} duplicates skipped)\n\n` +
                    `Total now: ${tasks.length} tasks, ${notes.length} notes`);
            }
        } catch (error) {
            console.error('Import error:', error);
            alert('❌ Error importing data:\n\n' + error.message + '\n\nPlease make sure the file is a valid Notemaker backup file.');
        }
    };
    
    reader.onerror = () => {
        alert('❌ Error reading file. Please try again.');
    };
    
    reader.readAsText(file);
}

// Theme Management
function switchTheme(theme) {
    // Remove all theme classes
    document.body.classList.remove('theme-ocean', 'theme-sunset', 'theme-forest', 'theme-purple', 'theme-dark');
    
    // Add selected theme
    if (theme !== 'ocean') {
        document.body.classList.add(`theme-${theme}`);
    }
    
    // Update active button
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.theme === theme) {
            btn.classList.add('active');
        }
    });
    
    // Save theme preference
    localStorage.setItem('notemaker_theme', theme);
}

// Utilities
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
}

