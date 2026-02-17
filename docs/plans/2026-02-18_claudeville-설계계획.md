# ClaudeVille - Claude Code 에이전트 시각화 대시보드

## Context

Claude Code에서 에이전트 팀(Team, SubAgent, 멀티 세션)이 작업하는 모습을 브라우저에서 실시간으로 모니터링하는 웹 앱.
캐릭터 모드(아이소메트릭 픽셀 월드)와 대시보드 모드(트레이스/로그) 전환 지원.
국내에 이런 서비스가 없어서 오픈소스로 공개 목표.

**레퍼런스**: Moltcraft (픽셀 월드 UI), AI Town (캐릭터 시뮬레이션)
**기술 스택**: 순수 HTML/CSS/JS (프레임워크 없음, 2MB 이하 목표)
**핵심 원칙**: 클린 아키텍처 - 레이어 분리, 단일 책임, 의존성 역전

---

## 아키텍처 설계 (Clean Architecture for Vanilla JS)

### 레이어 구조

```
┌─────────────────────────────────────────┐
│  Presentation Layer (UI/렌더링)          │
│  - Canvas 렌더링, DOM 조작, 이벤트 바인딩  │
├─────────────────────────────────────────┤
│  Application Layer (유즈케이스)           │
│  - 모드 전환, 세션 관리, 알림 로직         │
├─────────────────────────────────────────┤
│  Domain Layer (핵심 비즈니스 로직)         │
│  - Agent 엔티티, World 모델, 상태 머신     │
├─────────────────────────────────────────┤
│  Infrastructure Layer (외부 연동)         │
│  - 파일 시스템 읽기, WebSocket, API 통신   │
└─────────────────────────────────────────┘
```

### 폴더 구조

```
~/Desktop/dev/에이전트 시각화/claudeville/
├── index.html                  # 진입점
├── server.js                   # Node.js 백엔드 (파일 워치 + API)
│
├── src/
│   ├── domain/                 # 핵심 도메인 (의존성 없음)
│   │   ├── entities/
│   │   │   ├── Agent.js        # 에이전트 엔티티 (상태, 외모, 위치)
│   │   │   ├── Building.js     # 건물 엔티티
│   │   │   ├── World.js        # 월드 상태 (타일맵, 시간)
│   │   │   └── Task.js         # 태스크 엔티티
│   │   ├── value-objects/
│   │   │   ├── Position.js     # 타일 좌표
│   │   │   ├── Appearance.js   # 캐릭터 외모
│   │   │   └── AgentStatus.js  # 상태 enum (working/idle/waiting)
│   │   └── events/
│   │       └── DomainEvent.js  # 이벤트 버스 (옵저버 패턴)
│   │
│   ├── application/            # 유즈케이스
│   │   ├── AgentManager.js     # 에이전트 CRUD + 상태 갱신
│   │   ├── ModeManager.js      # 캐릭터↔대시보드 모드 전환
│   │   ├── SessionWatcher.js   # 세션 데이터 폴링/감시
│   │   └── NotificationService.js
│   │
│   ├── infrastructure/         # 외부 연동
│   │   ├── ClaudeDataSource.js # ~/.claude/ 파일 읽기 (서버 API 호출)
│   │   ├── WebSocketClient.js  # 실시간 업데이트 (서버 → 클라이언트)
│   │   └── SoundEngine.js      # Web Audio API 음향
│   │
│   ├── presentation/           # UI 렌더링
│   │   ├── character-mode/     # 캐릭터 모드
│   │   │   ├── IsometricRenderer.js  # 아이소메트릭 캔버스 렌더링
│   │   │   ├── AgentSprite.js        # 에이전트 캐릭터 그리기
│   │   │   ├── BuildingRenderer.js   # 건물 그리기
│   │   │   ├── ParticleSystem.js     # 파티클 이펙트
│   │   │   ├── Camera.js             # 카메라 (팬, 줌)
│   │   │   └── Minimap.js            # 미니맵
│   │   │
│   │   ├── dashboard-mode/     # 대시보드 모드
│   │   │   ├── DashboardRenderer.js  # 대시보드 전체 레이아웃
│   │   │   ├── TraceTimeline.js      # 트레이스 타임라인
│   │   │   ├── TokenChart.js         # 토큰 사용량 차트
│   │   │   └── MessageFlow.js        # 에이전트 간 메시지 흐름
│   │   │
│   │   ├── shared/             # 공유 UI
│   │   │   ├── Sidebar.js      # 에이전트 목록 사이드바
│   │   │   ├── TopBar.js       # 상단 상태 바
│   │   │   ├── Modal.js        # 모달 시스템
│   │   │   └── Toast.js        # 토스트 알림
│   │   │
│   │   └── App.js              # 앱 진입점 (DI 컨테이너)
│   │
│   └── config/
│       ├── constants.js        # 상수 (타일 크기, 색상, 간격)
│       ├── buildings.js        # 건물 정의 (좌표, 종류, 라벨)
│       └── theme.js            # 테마 (다크/라이트, 색상 팔레트)
│
├── css/
│   ├── reset.css
│   ├── layout.css              # 전체 레이아웃
│   ├── sidebar.css             # 사이드바
│   ├── topbar.css              # 상단 바
│   ├── modal.css               # 모달
│   ├── dashboard.css           # 대시보드 모드
│   └── character.css           # 캐릭터 모드
│
└── assets/                     # (선택) 스프라이트 시트 등
```

---

## 핵심 설계 결정

### 1. 데이터 소스: ~/.claude/ 파일 시스템 기반

```
server.js가 감시하는 파일들:
├── ~/.claude/history.jsonl      # 전체 대화/도구 히스토리 (5.3MB)
├── ~/.claude/teams/             # 팀 구성 (config.json)
├── ~/.claude/tasks/             # 태스크 상태
└── ~/.claude/projects/          # 프로젝트별 컨텍스트
```

- `server.js`가 `fs.watch`로 파일 변경 감지
- WebSocket으로 클라이언트에 실시간 푸시
- REST API도 제공 (초기 로드용)

### 2. 이벤트 기반 아키텍처

```
[파일 변경] → server.js → WebSocket → SessionWatcher
    → AgentManager.updateAgent(data)
        → DomainEvent.emit('agent:updated', agent)
            → IsometricRenderer.onAgentUpdated()  (캐릭터 모드)
            → DashboardRenderer.onAgentUpdated()  (대시보드 모드)
            → Sidebar.onAgentUpdated()
            → TopBar.onAgentUpdated()
```

### 3. 모드 전환 (캐릭터 ↔ 대시보드)

```javascript
// ModeManager.js
switchMode(mode) {
    this.currentMode = mode; // 'character' | 'dashboard'
    this.emit('mode:changed', mode);
    // 각 렌더러가 이벤트 듣고 show/hide
}
```

- 같은 데이터 소스, 다른 프레젠테이션
- 전환 시 애니메이션 (페이드 or 슬라이드)

### 4. 에이전트 엔티티 (Domain)

```javascript
// Agent.js - 프레임워크/UI 의존성 없음
class Agent {
    constructor({ id, name, model, status, role, tokens, messages }) { ... }

    get isWorking() { return this.status === 'working'; }
    get cost() { return this.tokens.input * 0.000003 + this.tokens.output * 0.000015; }

    // 결정론적 외모 생성 (해시 기반)
    generateAppearance() {
        const hash = this.hashCode(this.id);
        return new Appearance({ skin: SKINS[hash % SKINS.length], ... });
    }
}
```

### 5. 건물 = 기능 매핑

| 건물 | 역할 | 클릭 시 표시 |
|------|------|-------------|
| **Command Center** | 팀 현황 | 팀 구성, 에이전트 수, 전체 상태 |
| **Code Forge** | 코드 작업 | 현재 편집 중인 파일, 변경사항 |
| **Token Mine** | 토큰 사용량 | 모델별 비용, 사용량 차트 |
| **Task Board** | 태스크 현황 | 태스크 목록, 진행률, 의존성 |
| **Chat Hall** | 메시지 | 에이전트 간 대화 로그 |

---

## 1차 MVP 스코프 (Phase 1)

### 만들 것
1. **server.js** - ~/.claude/ 파일 감시 + REST API + WebSocket
2. **캐릭터 모드** - 아이소메트릭 맵 + 에이전트 캐릭터 + 건물 + 기본 파티클
3. **사이드바** - 에이전트 목록 + 상태 표시
4. **상단 바** - 토큰 수, 비용, WORKING/IDLE 카운트
5. **모드 전환 버튼** (대시보드 모드는 "Coming Soon" 표시)

### 안 만들 것 (Phase 2 이후)
- 대시보드 모드 상세 구현
- 음향 엔진
- 음성 인터페이스
- 주야 사이클 / 날씨
- 에이전트 채팅 기능
- 모바일 반응형

---

## 구현 순서

### Step 1: 프로젝트 초기화 + 백엔드
- 폴더 구조 생성
- `server.js` - 정적 파일 서빙 + ~/.claude/ 데이터 읽기 API
- WebSocket 서버 (파일 변경 감지 → 클라이언트 푸시)

### Step 2: 도메인 레이어
- Agent, Building, World, Task 엔티티
- Position, Appearance, AgentStatus 값 객체
- DomainEvent 이벤트 버스

### Step 3: 인프라 레이어
- ClaudeDataSource (서버 API 호출)
- WebSocketClient (실시간 업데이트 수신)

### Step 4: 캐릭터 모드 렌더링
- IsometricRenderer (타일맵, 좌표 변환)
- AgentSprite (캐릭터 그리기 + 걷기 애니메이션)
- BuildingRenderer (5개 건물)
- ParticleSystem (발자국, 반짝임)
- Camera (팬, 줌, 미니맵)

### Step 5: 공유 UI
- TopBar (토큰, 비용, 상태 카운트)
- Sidebar (에이전트 목록)
- Toast (알림)

### Step 6: Application 레이어 + 통합
- AgentManager (데이터 소스 → 도메인 → UI 연결)
- ModeManager (모드 전환 구조)
- App.js (DI, 초기화, 이벤트 와이어링)

### Step 7: 마무리
- 에이전트 클릭 시 상세 패널
- 건물 클릭 시 모달
- 반짝이/파티클 이펙트 추가
- README.md

---

## 검증 방법

1. `node server.js` 실행 → http://localhost:3000 접속
2. ~/.claude/ 에 데이터가 있으면 에이전트가 맵에 표시되는지 확인
3. Claude Code에서 팀/서브에이전트 실행 시 실시간 반영 확인
4. 캐릭터 모드 ↔ 대시보드 모드 전환 동작 확인
5. 에이전트 클릭 → 상세 패널 표시 확인
6. 건물 클릭 → 모달 표시 확인
