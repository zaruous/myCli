// =========================================================
// Diff 유틸리티
// LCS(Longest Common Subsequence) 기반 라인 단위 diff.
// 500줄 초과 시 O(m*n) 성능 제한으로 전체 교체 폴백.
// =========================================================
import chalk from 'chalk';

export function computeLineDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldLines.length > 500 || newLines.length > 500) {
    return [
      ...oldLines.map(l => ({ type: 'remove', line: l })),
      ...newLines.map(l => ({ type: 'add', line: l })),
    ];
  }

  const m = oldLines.length, n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'same', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', line: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', line: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

export function renderDiffWithContext(diffResult, contextLines = 3) {
  const changeIndices = new Set();
  diffResult.forEach((d, i) => { if (d.type !== 'same') changeIndices.add(i); });

  const showIndices = new Set();
  changeIndices.forEach(i => {
    for (let k = Math.max(0, i - contextLines); k <= Math.min(diffResult.length - 1, i + contextLines); k++)
      showIndices.add(k);
  });

  const output = [];
  let prevIdx = -1;
  for (const idx of [...showIndices].sort((a, b) => a - b)) {
    if (prevIdx !== -1 && idx > prevIdx + 1) output.push(chalk.gray('  ...'));
    const { type, line } = diffResult[idx];
    if (type === 'add')         output.push(chalk.green(`+ ${line}`));
    else if (type === 'remove') output.push(chalk.red(`- ${line}`));
    else                        output.push(chalk.gray(`  ${line}`));
    prevIdx = idx;
  }
  return output.join('\n');
}
