import { Extension, StateField, Transaction } from '@codemirror/state';
import { ViewUpdate, ViewPlugin, DecorationSet, Decoration, EditorView, WidgetType } from '@codemirror/view';
import P2PSyncPlugin from './main';

// A custom widget to render the cursor caret
class CursorWidget extends WidgetType {
    constructor(public color: string, public name: string) {
        super();
    }

    toDOM() {
        const wrap = document.createElement('span');
        wrap.className = 'p2p-cursor-caret';
        wrap.style.borderLeftColor = this.color;

        const label = document.createElement('span');
        label.className = 'p2p-cursor-name';
        label.textContent = this.name;
        label.style.backgroundColor = this.color;

        wrap.appendChild(label);
        return wrap;
    }
}

export function buildCursorExtension(plugin: P2PSyncPlugin): Extension {
    // We need to keep track of the current active file for this editor instance
    const awareness = plugin.yjsService.awareness;

    const cursorTheme = EditorView.baseTheme({
        '.p2p-cursor-caret': {
            position: 'relative',
            borderLeft: '2px solid', // Color is set inline
            marginLeft: '-1px',
            marginRight: '-1px',
            display: 'inline-block',
            height: '100%',
            minHeight: '1em',
            verticalAlign: 'middle',
            zIndex: '99',
            pointerEvents: 'auto'
        },
        '.p2p-cursor-name': {
            position: 'absolute',
            top: '-1.2em',
            left: '-1px',
            color: 'white',
            padding: '2px 4px',
            borderRadius: '4px',
            fontSize: '10px',
            whiteSpace: 'nowrap',
            opacity: '0',
            visibility: 'hidden',
            transition: 'opacity 0.2s',
            zIndex: '100',
            pointerEvents: 'none'
        },
        '.p2p-cursor-caret:hover .p2p-cursor-name': {
            opacity: '1',
            visibility: 'visible',
            pointerEvents: 'auto'
        },
        '.p2p-cursor-selection': {
            // color set dynamically via style injection
        }
    });

    const cursorStateField = StateField.define<DecorationSet>({
        create() {
            return Decoration.none;
        },
        update(decorations, tr) {
            return computeDecorations(plugin, tr);
        },
        provide: f => EditorView.decorations.from(f)
    });

    const cursorPlugin = ViewPlugin.fromClass(class {
        constructor(public view: EditorView) {
            this.handleAwarenessChange = this.handleAwarenessChange.bind(this);
            awareness.on('change', this.handleAwarenessChange);
        }

        handleAwarenessChange() {
            // Dispatch dummy transaction to trigger decoration recomputation
            // Wrap in setTimeout to avoid "Calls to EditorView.update are not allowed while an update is in progress"
            // This happens when awareness.setLocalState is called inside update()
            setTimeout(() => {
                this.view.dispatch({ annotations: [] });
            }, 0);
        }

        update(update: ViewUpdate) {
            if (update.selectionSet || update.docChanged || update.focusChanged) {
                const activeFile = plugin.app.workspace.getActiveFile();
                if (activeFile && update.view.hasFocus) {
                    const sel = update.state.selection.main;
                    const currentState = awareness.getLocalState();
                    const cursor = { from: sel.from, to: sel.to };

                    // Simple check to avoid redundant broadcasts
                    const oldCursor = currentState?.cursor;
                    if (oldCursor?.from !== cursor.from || oldCursor?.to !== cursor.to || currentState?.currentFile !== activeFile.path) {
                        // Batch updates to avoid multiple syncs
                        awareness.setLocalState({
                            ...currentState,
                            cursor: cursor,
                            currentFile: activeFile.path
                        });
                    }
                }
            }
        }

        destroy() {
            awareness.off('change', this.handleAwarenessChange);
            const currentState = awareness.getLocalState();
            if (currentState) {
                awareness.setLocalState({
                    ...currentState,
                    cursor: null,
                    currentFile: null
                });
            }
        }
    });

    return [cursorTheme, cursorStateField, cursorPlugin];
}

function computeDecorations(plugin: P2PSyncPlugin, tr: Transaction): DecorationSet {
    const activeFile = plugin.app.workspace.getActiveFile();
    if (!activeFile) return Decoration.none;

    const awareness = plugin.yjsService.awareness;
    const states = awareness.getStates();
    const localId = awareness.clientID;
    const docLength = tr.state.doc.length;

    const builder: any[] = [];

    for (const [clientId, state] of states.entries()) {
        if (clientId === localId) continue;

        if (!state.cursor || !state.currentFile || !state.name || !state.color) continue;

        if (state.currentFile !== activeFile.path) continue;

        let { from, to } = state.cursor as { from: number, to: number };

        from = Math.min(Math.max(from, 0), docLength);
        to = Math.min(Math.max(to, 0), docLength);

        const start = Math.min(from, to);
        const end = Math.max(from, to);

        if (start !== end) {
            builder.push(Decoration.mark({
                attributes: { style: `background-color: ${state.color}50;` },
                class: 'p2p-cursor-selection'
            }).range(start, end));
        }

        builder.push(Decoration.widget({
            widget: new CursorWidget(state.color, state.name),
            side: end === to ? 1 : -1 // Caret position logic
        }).range(to));
    }

    builder.sort((a, b) => a.from - b.from);
    return Decoration.set(builder);
}
