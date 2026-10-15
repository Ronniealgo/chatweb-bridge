// Serializable DOM reader for contenteditable/Quill. innerText includes CSS
// paragraph spacing; textContent loses line breaks. Neither is an exact readback.
export function readEditorText(element) {
  if (element.tagName === 'TEXTAREA') return element.value;
  function read(parent) {
    let result = '';
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { result += node.data; continue; }
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'BR') { result += '\n'; continue; }
      const block = ['P', 'DIV', 'LI'].includes(node.tagName);
      if (block && result && !result.endsWith('\n')) result += '\n';
      const value = read(node);
      result += block ? (value === '\n' ? '' : value) + '\n' : value;
    }
    return result;
  }
  return read(element).replace(/\n$/, '');
}
