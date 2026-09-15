import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export const datetimeTool = new DynamicStructuredTool({
  name: 'get_datetime',
  description: "OS의 현재 날짜·시간·타임존 정보를 반환합니다. '지금 몇 시야', '오늘 날짜', '현재 시간' 같은 질문에 사용하세요.",
  schema: z.object({}),
  func: async () => {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = -now.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0'), mm = String(Math.abs(offset) % 60).padStart(2, '0');
    return [`현재 날짜/시간 (OS 기준)`, `  날짜      : ${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`, `  시간      : ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`, `  타임존    : ${tz} (UTC${sign}${hh}:${mm})`, `  ISO 8601  : ${now.toISOString()}`, `  Unix 타임 : ${Math.floor(now.getTime() / 1000)}`].join('\n');
  },
});
