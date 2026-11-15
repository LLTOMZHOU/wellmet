// Optional enhancement: a Copy button for the assistant line. Without this
// script the line is still selectable text (user-select: all).
//
// Some browsers (embedded ones especially) refuse navigator.clipboard, so the
// button falls back to the older selection-based copy, and if that is refused
// too it leaves the line selected and asks for ⌘C / Ctrl+C.

function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyText(element) {
  const text = element.textContent.trim();
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused; try the older way below.
    }
  }
  selectText(element);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

const pressCopy = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Press ⌘C' : 'Press Ctrl+C';

document.querySelectorAll('[data-copy]').forEach((button) => {
  const target = document.getElementById(button.getAttribute('data-copy'));
  if (!target) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    const copied = await copyText(target);
    if (copied) {
      window.getSelection().removeAllRanges();
      button.textContent = 'Copied';
      button.setAttribute('data-done', '');
    } else {
      selectText(target);
      button.textContent = pressCopy;
    }
    setTimeout(() => {
      button.textContent = 'Copy';
      button.removeAttribute('data-done');
    }, 2500);
  });
});
