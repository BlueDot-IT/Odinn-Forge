export function openDialog(dialog: HTMLDialogElement | null): void { dialog?.showModal(); }
export function closeDialog(dialog: HTMLDialogElement | null): void { dialog?.close(); }
export function confirmDialog(message: string): boolean { return window.confirm(message); }
