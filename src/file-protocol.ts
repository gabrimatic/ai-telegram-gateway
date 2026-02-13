export const FILE_PROTOCOL = {
  attachedFileOpen: "<attached-file>",
  attachedFileClose: "</attached-file>",
  sendFileTag: "send-file",
  telegramApiTag: "telegram-api",
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

export function buildTelegramApiTag(method: string, payload: Record<string, unknown>): string {
  return `<${FILE_PROTOCOL.telegramApiTag} method="${method}" payload='${JSON.stringify(payload)}' />`;
}
