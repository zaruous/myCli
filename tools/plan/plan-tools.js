import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import chalk from 'chalk';
import { planModeState } from '../../lib/state.js';
import { selectKeyPrompt, inputPrompt } from '../../lib/ui.js';

export const planTools = [
  new DynamicStructuredTool({
    name: 'enter_plan_mode',
    description: '계획 모드(Plan Mode)에 진입합니다. 복잡한 구현 작업을 시작하기 전에 호출하세요. 계획 모드에서는 파일 수정이 차단되고, 코드베이스 탐색과 설계에 집중합니다.',
    schema: z.object({}),
    func: async () => {
      if (planModeState.active) return '이미 계획 모드 중입니다. exit_plan_mode로 계획을 제출하세요.';
      planModeState.active = true;
      planModeState.enteredAt = new Date();
      console.log(chalk.cyan('\n[계획 모드 진입] write_file, execute_shell_command가 차단됩니다.'));
      return '계획 모드에 진입했습니다.\n\n지금부터 다음 단계를 따르세요:\n1. glob_files, grep_files, read_file로 코드베이스를 철저히 탐색하세요\n2. 기존 패턴과 아키텍처를 파악하세요\n3. 여러 구현 방법과 그 트레이드오프를 검토하세요\n4. 구체적인 구현 계획을 수립하세요\n5. 준비가 되면 exit_plan_mode를 호출해 계획을 제출하고 승인을 받으세요\n\n주의: 계획 모드에서는 write_file과 execute_shell_command가 차단됩니다. 탐색과 설계에만 집중하세요.';
    },
  }),
  new DynamicStructuredTool({
    name: 'exit_plan_mode',
    description: '계획 모드를 종료하고 작성한 계획을 사용자에게 제출합니다. 사용자가 승인하면 구현을 시작할 수 있습니다.',
    schema: z.object({ plan: z.string().describe('작성한 구현 계획의 전체 내용. 구체적인 단계, 수정할 파일, 접근 방법을 포함하세요.') }),
    func: async ({ plan }) => {
      if (!planModeState.active) return '계획 모드 중이 아닙니다. enter_plan_mode를 먼저 호출하세요.';
      const elapsed = planModeState.enteredAt ? Math.round((Date.now() - planModeState.enteredAt) / 1000) : 0;
      console.log(chalk.cyan('\n' + '─'.repeat(60)));
      console.log(chalk.cyan.bold('📋 구현 계획 검토'));
      console.log(chalk.gray(`   계획 모드 소요 시간: ${elapsed}초`));
      console.log(chalk.cyan('─'.repeat(60)));
      console.log(plan);
      console.log(chalk.cyan('─'.repeat(60)));
      const decision = await selectKeyPrompt('이 계획을 승인하시겠습니까?', [{ key: 'y', label: '승인 - 이 계획으로 구현을 시작합니다', value: 'approve' }, { key: 'n', label: '거절 - 계획을 수정합니다', value: 'reject' }, { key: 'e', label: '수정 제안 - 피드백을 남기고 재계획합니다', value: 'feedback' }], 'y');
      if (decision === 'approve') { planModeState.active = false; planModeState.enteredAt = null; console.log(chalk.green('\n✅ 계획이 승인되었습니다. 구현을 시작하세요.\n')); return `사용자가 계획을 승인했습니다. 이제 구현을 시작하세요.\n\n승인된 계획:\n${plan}\n\n계획에 따라 순서대로 구현을 진행하세요. todo 목록이 있다면 업데이트하세요.`; }
      if (decision === 'feedback') { const feedback = await inputPrompt('수정 방향이나 피드백을 입력하세요:'); console.log(chalk.yellow('\n계획을 수정해주세요. 계획 모드를 유지합니다.\n')); return `사용자가 계획 수정을 요청했습니다. 계획 모드를 유지합니다.\n\n피드백: ${feedback}\n\n피드백을 반영해 계획을 수정한 후 exit_plan_mode를 다시 호출하세요.`; }
      console.log(chalk.yellow('\n계획이 거절되었습니다. 계획 모드를 유지합니다.\n'));
      return '사용자가 계획을 거절했습니다. 계획 모드를 유지합니다. 코드베이스를 더 탐색하거나 다른 접근 방법을 고려한 후 exit_plan_mode를 다시 호출하세요.';
    },
  }),
];
