export { createPrivateTextFile, openPrivateTextFile, createWindowsPrivateDirectory } from "./domain/private-text-file.js";
export { readWindowsRegularText, readWindowsOwnedText, writeWindowsOwnedText, replaceWindowsFilePreservingMetadata } from "./domain/windows-owned-text.js";
export { isWindowsDirectoryCaseSensitive, isWindowsDirectoryLink, replaceWindowsCopiedFile, windowsNamesCollide } from "./domain/windows-owned-text.js";
export { moveWindowsEntryNoReplace } from "./domain/windows-owned-text.js";
export { readWindowsEntryTimes } from "./domain/windows-owned-text.js";
export { copyWindowsFileNew } from "./domain/windows-owned-text.js";
