# ClaudeVille - 프로젝트 규칙

## 레이아웃 구조 (중요)

```
body (flex column, height 100vh)
  header.topbar          ← 48px 고정 높이, flex-shrink: 0
  div.main               ← flex: 1, flex-direction: column
    div.main__body       ← flex: 1, display: flex (가로 배치)
      aside.sidebar      ← width: 240px, flex-shrink: 0
      div.content        ← flex: 1 (캐릭터/대시보드 모드)
    div#agentDetail      ← flex-shrink: 0 (선택 시 하단에 표시)
```

### 주의사항
- **절대 `position: fixed`로 UI 요소를 배치하지 말 것** (모달, 토스트 제외)
- 새 패널 추가 시 반드시 flex 레이아웃 안에서 배치해야 함
- topbar(48px) + agentDetail(최대 200px)이 컨텐츠 영역을 줄이므로, 새 컴포넌트 추가 시 남은 공간 계산 필요
- 대시보드 모드는 `overflow-y: auto`로 스크롤, 캐릭터 모드는 캔버스가 남은 영역을 채움

## 기술 스택
- 순수 HTML/CSS/JS (프레임워크 없음)
- ES Modules (import/export)
- Node.js 서버 (server.js) - HTTP + WebSocket (RFC 6455 직접 구현)
- Canvas 2D API로 아이소메트릭 렌더링
- 데이터 소스: ~/.claude/ 디렉토리 (history.jsonl, projects/, teams/, tasks/)

## 모드
- **WORLD**: 아이소메트릭 픽셀 월드에서 에이전트가 캐릭터로 돌아다님
- **DASHBOARD**: 에이전트별 카드 형태로 도구 사용/활동 실시간 모니터링
