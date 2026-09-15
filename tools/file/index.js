import { readFileTool } from './read-tool.js';
import { writeFileTool } from './write-tool.js';
import { editFileTool } from './edit-tool.js';
import { globFilesTool } from './glob-tool.js';
import { grepFilesTool } from './grep-tool.js';

export const fileTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globFilesTool,
  grepFilesTool,
];
