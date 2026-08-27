export async function copyText(value: string): Promise<void> {
  let clipboardError: unknown;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch (error) {
    clipboardError = error;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand?.("copy")) {
      throw clipboardError instanceof Error ? clipboardError : new Error("Clipboard unavailable");
    }
  } finally {
    textarea.remove();
  }
}
