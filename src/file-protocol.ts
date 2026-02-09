export const FILE_PROTOCOL = {
  attachedFileOpen: "<attached-file>",
  attachedFileClose: "</attached-file>",
  sendFileTag: "send-file",
};

export function buildAttachedFileBlock(lines: string[]): string {
  return [FILE_PROTOCOL.attachedFileOpen, ...lines, FILE_PROTOCOL.attachedFileClose].join("\n");
}

export function buildSendFileTag(path: string, caption?: string): string {
  if (caption) {
    return `<${FILE_PROTOCOL.sendFileTag} path="${path}" caption="${caption}" />`;
  }
  return `<${FILE_PROTOCOL.sendFileTag} path="${path}" />`;
}
