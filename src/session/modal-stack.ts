// src/session/modal-stack.ts
//
// Tracks the open modal-form chain server-side. BC's web server holds a
// LogicalDispatcher.Frames stack (decompiled
// Microsoft.Dynamics.Framework.UI.LogicalDispatcher); to clear an orphaned
// modal we must Abort the topmost frame. The ModalStack mirrors that
// ordering on the client side so reconciliation can walk the stack from top
// to bottom.

export class ModalStack {
  private readonly ids: string[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(formId: string): void {
    if (!formId) return;
    const ix = this.ids.indexOf(formId);
    if (ix >= 0) return; // dedupe -- DialogOpened may fire twice in some envs
    this.ids.push(formId);
  }

  pop(): string | undefined {
    return this.ids.pop();
  }

  peek(): string | undefined {
    return this.ids[this.ids.length - 1];
  }

  remove(formId: string): void {
    const ix = this.ids.indexOf(formId);
    if (ix >= 0) this.ids.splice(ix, 1);
  }

  clear(): void {
    this.ids.length = 0;
  }

  snapshot(): string[] {
    return [...this.ids];
  }
}
