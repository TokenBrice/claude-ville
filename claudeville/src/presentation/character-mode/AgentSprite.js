import { Position } from '../../domain/value-objects/Position.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TILE_WIDTH, TILE_HEIGHT, AGENT_SPEED } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { THEME } from '../../config/theme.js';

export class AgentSprite {
    constructor(agent) {
        this.agent = agent;
        this.x = 0;
        this.y = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.moving = false;
        this.facingLeft = false;
        this.walkFrame = 0;
        this.waitTimer = 0;
        this.selected = false;
        this.statusAnim = 0;
        this._lastBuildingType = null;

        // 대화 시스템
        this.chatPartner = null;     // 대화 상대 AgentSprite
        this.chatting = false;       // 대화 중 여부
        this.chatTimer = 0;          // 대화 애니메이션 타이머
        this.chatBubbleAnim = 0;     // 말풍선 애니메이션

        const screen = agent.position.toScreen(TILE_WIDTH, TILE_HEIGHT);
        this.x = screen.x;
        this.y = screen.y;

        this._pickTarget();
    }

    _pickTarget() {
        // 대화 상대가 있으면 상대 위치로 이동
        if (this.chatPartner) {
            this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
            this.targetY = this.chatPartner.y;
            this.moving = true;
            this.waitTimer = 0;
            return;
        }

        // WORKING일 때만 도구 기반 이동, IDLE/WAITING이면 자유 이동
        const isWorking = this.agent.status === AgentStatus.WORKING;
        const buildingType = isWorking ? this.agent.targetBuildingType : null;
        let building = null;

        if (buildingType) {
            building = BUILDING_DEFS.find(b => b.type === buildingType);
        }

        if (!building) {
            // 매핑 없으면 랜덤 건물 70%, 빈 땅 30%
            if (Math.random() < 0.7) {
                building = BUILDING_DEFS[Math.floor(Math.random() * BUILDING_DEFS.length)];
            } else {
                const tx = 10 + Math.random() * 20;
                const ty = 10 + Math.random() * 20;
                const target = new Position(tx, ty);
                const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
                this.targetX = screen.x;
                this.targetY = screen.y;
                this.moving = true;
                this.waitTimer = 0;
                return;
            }
        }

        // 건물 내부로 이동 (건물 중심 부근)
        const tx = building.x + 0.3 * building.width + Math.random() * 0.4 * building.width;
        const ty = building.y + 0.3 * building.height + Math.random() * 0.4 * building.height;
        const target = new Position(tx, ty);
        const screen = target.toScreen(TILE_WIDTH, TILE_HEIGHT);
        this.targetX = screen.x;
        this.targetY = screen.y;
        this.moving = true;
        this.waitTimer = 0;
    }

    update(particleSystem) {
        this.statusAnim += 0.05;

        // 대화 중 상태 처리
        if (this.chatting) {
            this.chatBubbleAnim += 0.06;
            // 대화 상대가 가까이 있으면 서로 마주보기
            if (this.chatPartner) {
                this.facingLeft = this.chatPartner.x < this.x;
            }
            return; // 대화 중엔 이동 안 함
        }

        // 대화 상대를 향해 이동 중 → 가까워지면 대화 시작
        if (this.chatPartner) {
            const cpDx = this.chatPartner.x - this.x;
            const cpDy = this.chatPartner.y - this.y;
            const cpDist = Math.sqrt(cpDx * cpDx + cpDy * cpDy);
            if (cpDist < 35) {
                this.chatting = true;
                this.chatBubbleAnim = 0;
                this.moving = false;
                this.walkFrame = 0;
                this.facingLeft = cpDx < 0;
                // 상대도 대화 상태로
                if (!this.chatPartner.chatting) {
                    this.chatPartner.chatPartner = this;
                    this.chatPartner.chatting = true;
                    this.chatPartner.chatBubbleAnim = 0;
                    this.chatPartner.moving = false;
                    this.chatPartner.walkFrame = 0;
                    this.chatPartner.facingLeft = cpDx > 0;
                }
                return;
            }
            // 상대 위치가 변하면 타겟 갱신
            this.targetX = this.chatPartner.x + (this.x < this.chatPartner.x ? -25 : 25);
            this.targetY = this.chatPartner.y;
        }

        // WORKING 상태에서 도구가 바뀌면 즉시 새 건물로 방향 전환
        if (this.agent.status === AgentStatus.WORKING && !this.chatPartner) {
            const curBuilding = this.agent.targetBuildingType;
            if (curBuilding && curBuilding !== this._lastBuildingType) {
                this._lastBuildingType = curBuilding;
                this._pickTarget();
            }
        } else if (!this.chatPartner) {
            this._lastBuildingType = null;
        }

        if (this.waitTimer > 0) {
            this.waitTimer--;
            if (this.waitTimer <= 0) {
                this._pickTarget();
            }
            return;
        }

        if (!this.moving) {
            this._pickTarget();
            return;
        }

        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 2) {
            this.moving = false;
            this.waitTimer = this.chatPartner ? 10 : 60 + Math.floor(Math.random() * 180);
            this.walkFrame = 0;
            return;
        }

        const speed = this.chatPartner ? 2.5 : 1.5; // 대화하러 갈 땐 좀 더 빨리
        this.x += (dx / dist) * speed;
        this.y += (dy / dist) * speed;
        this.walkFrame += 0.15;
        this.facingLeft = dx < 0;

        if (particleSystem && Math.random() < 0.3) {
            particleSystem.spawn('footstep', this.x, this.y + 16, 1);
        }
    }

    /** 대화 시작 (IsometricRenderer에서 호출) */
    startChat(partnerSprite) {
        this.chatPartner = partnerSprite;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._pickTarget(); // 상대에게 이동 시작
    }

    /** 대화 종료 */
    endChat() {
        this.chatPartner = null;
        this.chatting = false;
        this.chatBubbleAnim = 0;
        this._pickTarget(); // 원래 행동 복귀
    }

    draw(ctx, zoom = 1) {
        this._zoom = zoom;

        ctx.save();
        ctx.translate(this.x, this.y);

        if (this.selected) {
            ctx.beginPath();
            ctx.ellipse(0, 16, 14, 6, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
            ctx.fill();
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        const scaleX = this.facingLeft ? -1 : 1;
        ctx.scale(scaleX, 1);

        const swing = this.moving ? Math.sin(this.walkFrame * 4) * 4 : 0;
        const app = this.agent.appearance;

        // Legs
        ctx.strokeStyle = app.pants;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-3, 8);
        ctx.lineTo(-3 - swing, 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(3, 8);
        ctx.lineTo(3 + swing, 16);
        ctx.stroke();

        // Body
        ctx.fillStyle = app.shirt;
        ctx.fillRect(-5, -2, 10, 12);

        // Arms
        ctx.strokeStyle = app.skin;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-8 + swing, 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(8 - swing, 8);
        ctx.stroke();

        // Head
        ctx.fillStyle = app.skin;
        ctx.beginPath();
        ctx.arc(0, -6, 5, 0, Math.PI * 2);
        ctx.fill();

        // Hair
        this._drawHair(ctx, app);

        // Eyes
        this._drawEyes(ctx, app);

        // Accessory
        this._drawAccessory(ctx, app);

        ctx.restore();

        // 대화 중 이펙트
        if (this.chatting) {
            this._drawChatEffect(ctx);
        }

        // Status indicators (drawn without flip, zoom-independent)
        if (!this.chatting) {
            this._drawStatus(ctx);
        }
        this._drawNameTag(ctx);
    }

    _drawHair(ctx, app) {
        ctx.fillStyle = app.hair;
        switch (app.hairStyle) {
            case 'short':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                break;
            case 'long':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                ctx.fillRect(-5, -8, 2, 8);
                ctx.fillRect(3, -8, 2, 8);
                break;
            case 'spiky':
                ctx.beginPath();
                ctx.moveTo(-4, -8);
                ctx.lineTo(-2, -14);
                ctx.lineTo(0, -9);
                ctx.lineTo(2, -14);
                ctx.lineTo(4, -8);
                ctx.fill();
                break;
            case 'mohawk':
                ctx.fillRect(-1, -14, 2, 6);
                break;
            case 'bald':
                break;
        }
    }

    _drawEyes(ctx, app) {
        ctx.fillStyle = '#000';
        switch (app.eyeStyle) {
            case 'normal':
                ctx.fillRect(-3, -7, 2, 2);
                ctx.fillRect(1, -7, 2, 2);
                break;
            case 'happy':
                ctx.beginPath();
                ctx.arc(-2, -6, 1.5, 0, Math.PI);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(2, -6, 1.5, 0, Math.PI);
                ctx.stroke();
                break;
            case 'determined':
                ctx.fillRect(-3, -7, 2, 1.5);
                ctx.fillRect(1, -7, 2, 1.5);
                break;
            case 'sleepy':
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-3, -6);
                ctx.lineTo(-1, -6);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(1, -6);
                ctx.lineTo(3, -6);
                ctx.stroke();
                break;
        }
    }

    _drawAccessory(ctx, app) {
        switch (app.accessory) {
            case 'crown':
                ctx.fillStyle = '#ffd700';
                ctx.beginPath();
                ctx.moveTo(-4, -12);
                ctx.lineTo(-4, -15);
                ctx.lineTo(-2, -13);
                ctx.lineTo(0, -16);
                ctx.lineTo(2, -13);
                ctx.lineTo(4, -15);
                ctx.lineTo(4, -12);
                ctx.closePath();
                ctx.fill();
                break;
            case 'glasses':
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.rect(-4, -8, 3, 3);
                ctx.rect(1, -8, 3, 3);
                ctx.moveTo(-1, -6.5);
                ctx.lineTo(1, -6.5);
                ctx.stroke();
                break;
            case 'headphones':
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(0, -7, 6, Math.PI, 0);
                ctx.stroke();
                ctx.fillStyle = '#555';
                ctx.fillRect(-7, -7, 3, 4);
                ctx.fillRect(4, -7, 3, 4);
                break;
            case 'hat':
                ctx.fillStyle = '#8b4513';
                ctx.fillRect(-6, -12, 12, 2);
                ctx.fillRect(-3, -16, 6, 4);
                break;
        }
    }

    _drawStatus(ctx) {
        const agent = this.agent;
        const t = this.statusAnim;
        const bubble = agent.bubbleText;
        const s = 1 / (this._zoom || 1); // 줌 역보정

        if (agent.status === AgentStatus.WORKING || (agent.status === AgentStatus.WAITING && bubble)) {
            this._drawBubble(ctx, bubble || '...', agent.status === AgentStatus.WORKING ? THEME.working : '#f97316');
        } else if (agent.status === AgentStatus.IDLE) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.scale(s, s); // 줌 역보정
            ctx.fillStyle = THEME.idle;
            ctx.textAlign = 'center';
            const offsetY = Math.sin(t * 1.5) * 4;
            ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 2);
            ctx.font = 'bold 9px sans-serif';
            ctx.fillText('z', 10, -22 + offsetY);
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText('z', 16, -32 + offsetY);
            ctx.font = 'bold 16px sans-serif';
            ctx.fillText('Z', 22, -44 + offsetY);
            ctx.globalAlpha = 1;
            ctx.restore();
        } else if (agent.status === AgentStatus.WAITING) {
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.scale(s, s); // 줌 역보정
            ctx.translate(0, -36);
            ctx.fillStyle = 'rgba(26, 26, 46, 0.9)';
            ctx.strokeStyle = '#f97316';
            ctx.lineWidth = 1.5;
            this._bubblePath(ctx, 36);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#eee';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            const dots = '.'.repeat(1 + Math.floor(t * 2) % 3);
            ctx.fillText(dots, 0, 3);
            ctx.restore();
        }
    }

    _drawBubble(ctx, text, accentColor) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // 줌 역보정

        ctx.translate(this.x, this.y);
        ctx.scale(s, s); // 화면 기준 고정 크기

        // 텍스트 크기 측정 + 자동 잘림
        ctx.font = 'bold 11px sans-serif';
        const maxWidth = 180;
        let displayText = text;
        // 글자 수 대신 실제 픽셀 폭 기준으로 잘라내기
        while (displayText.length > 0 && ctx.measureText(displayText).width > maxWidth) {
            displayText = displayText.substring(0, displayText.length - 1);
        }
        if (displayText.length < text.length) {
            displayText = displayText.substring(0, displayText.length - 1) + '…';
        }
        const textWidth = ctx.measureText(displayText).width;
        const bubbleW = textWidth + 20;
        const bubbleH = 24;
        const radius = 6;

        ctx.translate(0, -38);

        // 말풍선 배경
        const halfW = bubbleW / 2;
        ctx.fillStyle = 'rgba(26, 26, 46, 0.92)';
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-halfW + radius, -bubbleH / 2);
        ctx.lineTo(halfW - radius, -bubbleH / 2);
        ctx.quadraticCurveTo(halfW, -bubbleH / 2, halfW, -bubbleH / 2 + radius);
        ctx.lineTo(halfW, bubbleH / 2 - radius);
        ctx.quadraticCurveTo(halfW, bubbleH / 2, halfW - radius, bubbleH / 2);
        ctx.lineTo(4, bubbleH / 2);
        ctx.lineTo(0, bubbleH / 2 + 7);
        ctx.lineTo(-4, bubbleH / 2);
        ctx.lineTo(-halfW + radius, bubbleH / 2);
        ctx.quadraticCurveTo(-halfW, bubbleH / 2, -halfW, bubbleH / 2 - radius);
        ctx.lineTo(-halfW, -bubbleH / 2 + radius);
        ctx.quadraticCurveTo(-halfW, -bubbleH / 2, -halfW + radius, -bubbleH / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 텍스트
        ctx.fillStyle = '#eee';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayText, 0, 0, maxWidth);

        ctx.restore();
    }

    _bubblePath(ctx, width) {
        const hw = width / 2;
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(-hw, -10);
        ctx.lineTo(hw, -10);
        ctx.quadraticCurveTo(hw + r, -10, hw + r, -10 + r);
        ctx.lineTo(hw + r, 4);
        ctx.quadraticCurveTo(hw + r, 8, hw, 8);
        ctx.lineTo(3, 8);
        ctx.lineTo(0, 14);
        ctx.lineTo(-3, 8);
        ctx.lineTo(-hw, 8);
        ctx.quadraticCurveTo(-hw - r, 8, -hw - r, 4);
        ctx.lineTo(-hw - r, -10 + r);
        ctx.quadraticCurveTo(-hw - r, -10, -hw, -10);
        ctx.closePath();
    }

    _drawChatEffect(ctx) {
        ctx.save();
        const s = 1 / (this._zoom || 1);
        ctx.translate(this.x, this.y);
        ctx.scale(s, s);

        const t = this.chatBubbleAnim;

        // 말풍선 (번갈아 나타나는 효과)
        const phase = Math.floor(t * 1.5) % 3;
        const bubbleY = -38;

        // 배경 원
        ctx.fillStyle = 'rgba(26, 26, 46, 0.92)';
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, bubbleY, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 꼬리
        ctx.fillStyle = 'rgba(26, 26, 46, 0.92)';
        ctx.beginPath();
        ctx.moveTo(-3, bubbleY + 12);
        ctx.lineTo(0, bubbleY + 18);
        ctx.lineTo(3, bubbleY + 12);
        ctx.fill();

        // 대화 아이콘 (말풍선 안에 점점점 애니메이션)
        ctx.fillStyle = '#4ade80';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const dots = ['.', '..', '...'][phase];
        ctx.fillText(dots, 0, bubbleY - 1);

        // 위에 떠다니는 이모지 파티클
        const floatY = -56 + Math.sin(t * 2) * 4;
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 3);
        ctx.font = '12px sans-serif';
        const emojis = ['\u{1F4AC}', '\u{1F4AD}', '\u2728'];
        ctx.fillText(emojis[Math.floor(t) % emojis.length], 0, floatY);
        ctx.globalAlpha = 1;

        ctx.restore();
    }

    _drawNameTag(ctx) {
        ctx.save();
        const s = 1 / (this._zoom || 1); // 줌 역보정
        ctx.translate(this.x, this.y);
        ctx.scale(s, s); // 화면 기준 고정 크기
        ctx.translate(0, 24);
        const name = this.agent.name;
        ctx.font = 'bold 10px sans-serif';
        const w = ctx.measureText(name).width + 10;
        ctx.fillStyle = 'rgba(232, 212, 77, 0.92)';
        const h = 16, r = 4;
        ctx.beginPath();
        ctx.moveTo(-w/2 + r, -h/2);
        ctx.lineTo(w/2 - r, -h/2);
        ctx.quadraticCurveTo(w/2, -h/2, w/2, -h/2 + r);
        ctx.lineTo(w/2, h/2 - r);
        ctx.quadraticCurveTo(w/2, h/2, w/2 - r, h/2);
        ctx.lineTo(-w/2 + r, h/2);
        ctx.quadraticCurveTo(-w/2, h/2, -w/2, h/2 - r);
        ctx.lineTo(-w/2, -h/2 + r);
        ctx.quadraticCurveTo(-w/2, -h/2, -w/2 + r, -h/2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#1a1a2e';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, 0, 1);
        ctx.restore();
    }

    hitTest(screenX, screenY) {
        const dx = screenX - this.x;
        const dy = screenY - this.y;
        return Math.abs(dx) < 12 && dy > -20 && dy < 20;
    }
}
