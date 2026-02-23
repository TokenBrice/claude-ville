import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { Camera } from './Camera.js';
import { ParticleSystem } from './ParticleSystem.js';
import { AgentSprite } from './AgentSprite.js';
import { BuildingRenderer } from './BuildingRenderer.js';
import { Minimap } from './Minimap.js';

export class IsometricRenderer {
    constructor(world) {
        this.world = world;
        this.canvas = null;
        this.ctx = null;
        this.camera = null;
        this.particleSystem = new ParticleSystem();
        this.buildingRenderer = new BuildingRenderer(this.particleSystem);
        this.minimap = new Minimap();
        this.agentSprites = new Map();
        this.running = false;
        this.frameId = null;
        this.terrainCache = null;
        this.terrainSeed = [];
        this.waterFrame = 0;
        this.selectedAgent = null;
        this.onAgentSelect = null;

        // Generate terrain seed for consistent random patterns
        for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
            this.terrainSeed.push(Math.random());
        }

        // Path tiles (near buildings)
        this.pathTiles = new Set();
        this._generatePaths();

        // Water tiles
        this.waterTiles = new Set();
        this._generateWater();

        // Event subscriptions
        this._unsubscribers = [];
    }

    _generatePaths() {
        const buildingDefs = Array.from(this.world.buildings.values());
        for (const b of buildingDefs) {
            // Paths around buildings
            for (let x = b.position.tileX - 1; x <= b.position.tileX + b.width; x++) {
                for (let y = b.position.tileY - 1; y <= b.position.tileY + b.height; y++) {
                    if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
                        this.pathTiles.add(`${x},${y}`);
                    }
                }
            }
        }
        // Connecting roads between buildings (simple horizontal/vertical)
        if (buildingDefs.length >= 2) {
            for (let i = 0; i < buildingDefs.length - 1; i++) {
                const a = buildingDefs[i];
                const bDef = buildingDefs[i + 1];
                const ax = Math.floor(a.position.tileX + a.width / 2);
                const ay = Math.floor(a.position.tileY + a.height / 2);
                const bx = Math.floor(bDef.position.tileX + bDef.width / 2);
                const by = Math.floor(bDef.position.tileY + bDef.height / 2);
                // Horizontal then vertical
                const startX = Math.min(ax, bx);
                const endX = Math.max(ax, bx);
                for (let x = startX; x <= endX; x++) {
                    this.pathTiles.add(`${x},${ay}`);
                    this.pathTiles.add(`${x},${ay + 1}`);
                }
                const startY = Math.min(ay, by);
                const endY = Math.max(ay, by);
                for (let y = startY; y <= endY; y++) {
                    this.pathTiles.add(`${bx},${y}`);
                    this.pathTiles.add(`${bx + 1},${y}`);
                }
            }
        }
    }

    _generateWater() {
        // Small pond near bottom-left
        for (let x = 3; x <= 8; x++) {
            for (let y = 30; y <= 35; y++) {
                const dist = Math.sqrt(Math.pow(x - 5.5, 2) + Math.pow(y - 32.5, 2));
                if (dist < 3) {
                    this.waterTiles.add(`${x},${y}`);
                }
            }
        }
    }

    show(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.camera = new Camera(canvas);
        this.camera.attach();

        this.buildingRenderer.setBuildings(this.world.buildings);

        // Create sprites for existing agents
        for (const agent of this.world.agents.values()) {
            this._addAgentSprite(agent);
        }

        // Subscribe to domain events
        this._unsubscribers.push(
            eventBus.on('agent:added', (agent) => this._addAgentSprite(agent)),
            eventBus.on('agent:removed', (agent) => this.agentSprites.delete(agent.id)),
            eventBus.on('agent:updated', (agent) => {
                const sprite = this.agentSprites.get(agent.id);
                if (sprite) sprite.agent = agent;
            }),
        );

        // Minimap
        this.minimap.attach(canvas.parentNode);
        this.minimap.onNavigate = (tileX, tileY) => {
            const screenPos = {
                x: (tileX - tileY) * TILE_WIDTH / 2,
                y: (tileX + tileY) * TILE_HEIGHT / 2,
            };
            this.camera.x = -screenPos.x + canvas.width / (2 * this.camera.zoom);
            this.camera.y = -screenPos.y + canvas.height / (2 * this.camera.zoom);
        };

        // Click handler for agent selection
        this._onClick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const worldPos = this.camera.screenToWorld(screenX, screenY);
            this._handleClick(worldPos.x, worldPos.y);
        };
        canvas.addEventListener('click', this._onClick);

        // Hover handler for buildings
        this._onMouseMoveMain = (e) => {
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const worldPos = this.camera.screenToWorld(screenX, screenY);
            this.buildingRenderer.hoveredBuilding = this.buildingRenderer.hitTest(worldPos.x, worldPos.y);
        };
        canvas.addEventListener('mousemove', this._onMouseMoveMain);

        this.running = true;
        this._loop();
    }

    hide() {
        this.running = false;
        if (this.frameId) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        if (this.camera) {
            this.camera.detach();
        }
        this.minimap.detach();
        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._unsubscribers = [];
        if (this.canvas) {
            this.canvas.removeEventListener('click', this._onClick);
            this.canvas.removeEventListener('mousemove', this._onMouseMoveMain);
        }
        this.agentSprites.clear();
        this.particleSystem.clear();
    }

    _addAgentSprite(agent) {
        if (!this.agentSprites.has(agent.id)) {
            this.agentSprites.set(agent.id, new AgentSprite(agent));
        }
    }

    _handleClick(worldX, worldY) {
        // Check agents first
        let clicked = null;
        for (const sprite of this.agentSprites.values()) {
            if (sprite.hitTest(worldX, worldY)) {
                clicked = sprite;
                break;
            }
        }

        // Deselect all
        for (const sprite of this.agentSprites.values()) {
            sprite.selected = false;
        }

        if (clicked) {
            clicked.selected = true;
            this.selectedAgent = clicked.agent;
            this.camera.followAgent(clicked);
            if (this.onAgentSelect) this.onAgentSelect(clicked.agent);
        } else {
            this.selectedAgent = null;
            this.camera.stopFollow();
            if (this.onAgentSelect) this.onAgentSelect(null);
        }
    }

    _loop() {
        if (!this.running) return;
        this._update();
        this._render();
        this.frameId = requestAnimationFrame(() => this._loop());
    }

    _updateChatMatching() {
        // 현재 SendMessage 사용 중인 에이전트 찾기
        const senders = new Set();

        for (const sprite of this.agentSprites.values()) {
            const agent = sprite.agent;
            if (agent.currentTool === 'SendMessage' && agent.currentToolInput) {
                senders.add(sprite);

                // 이미 대화 중이면 스킵
                if (sprite.chatPartner) continue;

                // 수신자 이름으로 스프라이트 찾기
                const recipientName = agent.currentToolInput;
                let target = null;
                for (const other of this.agentSprites.values()) {
                    if (other === sprite) continue;
                    if (other.agent.name === recipientName) {
                        target = other;
                        break;
                    }
                }

                if (target) {
                    sprite.startChat(target);
                }
            }
        }

        // SendMessage가 아닌 에이전트의 대화 상태 해제
        for (const sprite of this.agentSprites.values()) {
            if (sprite.chatPartner && !senders.has(sprite)) {
                // 상대방이 아직 SendMessage 중이면 유지
                if (sprite.chatPartner.agent.currentTool === 'SendMessage') continue;
                sprite.endChat();
            }
        }
    }

    selectAgentById(agentId) {
        for (const sprite of this.agentSprites.values()) {
            sprite.selected = false;
        }
        if (agentId) {
            const sprite = this.agentSprites.get(agentId);
            if (sprite) {
                sprite.selected = true;
                this.selectedAgent = sprite.agent;
                this.camera.followAgent(sprite);
                return;
            }
        }
        this.selectedAgent = null;
        this.camera.stopFollow();
    }

    _update() {
        this.waterFrame += 0.03;

        // 카메라 팔로우 업데이트
        if (this.camera) this.camera.updateFollow();

        // 대화 매칭: SendMessage 사용 중인 에이전트 → 수신자 스프라이트로 이동
        this._updateChatMatching();

        // Update agent sprites
        for (const sprite of this.agentSprites.values()) {
            sprite.update(this.particleSystem);
        }

        // Update building renderer (에이전트 스프라이트 위치 전달)
        this.buildingRenderer.setAgentSprites(Array.from(this.agentSprites.values()));
        this.buildingRenderer.update();

        // Update particles
        this.particleSystem.update();
    }

    _render() {
        const ctx = this.ctx;
        const canvas = this.canvas;

        // Clear
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = THEME.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Apply camera
        this.camera.applyTransform(ctx);

        // 1. Terrain
        this._drawTerrain(ctx);

        // 2. Building shadows
        this.buildingRenderer.drawShadows(ctx);

        // 3. Buildings
        this.buildingRenderer.draw(ctx);

        // 4. Agents (sorted by Y for depth)
        const sortedSprites = Array.from(this.agentSprites.values())
            .sort((a, b) => a.y - b.y);
        const zoom = this.camera.zoom;
        for (const sprite of sortedSprites) {
            sprite.draw(ctx, zoom);
        }

        // 5. Particles
        this.particleSystem.draw(ctx);

        // 6. Building bubbles (on top)
        this.buildingRenderer.drawBubbles(ctx, this.world);

        // Reset transform for UI
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        // Minimap
        this.minimap.draw(this.world, this.camera, canvas);
    }

    _drawTerrain(ctx) {
        // 아이소메트릭은 다이아몬드 형태라 화면 네 모서리 모두 체크해야 함
        const w = this.canvas.width;
        const h = this.canvas.height;
        const c1 = this.camera.screenToTile(0, 0);
        const c2 = this.camera.screenToTile(w, 0);
        const c3 = this.camera.screenToTile(0, h);
        const c4 = this.camera.screenToTile(w, h);

        const margin = 5;
        const startX = Math.max(0, Math.min(c1.tileX, c2.tileX, c3.tileX, c4.tileX) - margin);
        const endX = Math.min(MAP_SIZE - 1, Math.max(c1.tileX, c2.tileX, c3.tileX, c4.tileX) + margin);
        const startY = Math.max(0, Math.min(c1.tileY, c2.tileY, c3.tileY, c4.tileY) - margin);
        const endY = Math.min(MAP_SIZE - 1, Math.max(c1.tileY, c2.tileY, c3.tileY, c4.tileY) + margin);

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                this._drawTile(ctx, x, y);
            }
        }
    }

    _drawTile(ctx, tileX, tileY) {
        const screenX = (tileX - tileY) * TILE_WIDTH / 2;
        const screenY = (tileX + tileY) * TILE_HEIGHT / 2;
        const key = `${tileX},${tileY}`;
        const seed = this.terrainSeed[tileY * MAP_SIZE + tileX] || 0;

        let fillColor;
        if (this.waterTiles.has(key)) {
            const waterIdx = Math.floor(seed * THEME.water.length);
            fillColor = THEME.water[waterIdx];
        } else if (this.pathTiles.has(key)) {
            const pathIdx = Math.floor(seed * THEME.path.length);
            fillColor = THEME.path[pathIdx];
        } else {
            const grassIdx = Math.floor(seed * THEME.grass.length);
            fillColor = THEME.grass[grassIdx];
        }

        ctx.fillStyle = fillColor;
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.closePath();
        ctx.fill();

        // Tile border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Water shimmer effect
        if (this.waterTiles.has(key)) {
            const shimmer = Math.sin(this.waterFrame * 2 + tileX * 0.5 + tileY * 0.3) * 0.15 + 0.1;
            ctx.fillStyle = `rgba(255, 255, 255, ${shimmer})`;
            ctx.fill();
        }
    }
}
