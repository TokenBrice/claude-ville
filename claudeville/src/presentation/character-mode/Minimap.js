import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';
import { getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';

const MINIMAP_SIZE = 150;

const BUILDING_COLORS = {
    command: '#c83d2d',
    forge: '#d8843a',
    mine: '#e8c15e',
    taskboard: '#78c6e7',
    observatory: '#c9903f',
    archive: '#d8b96d',
    portal: '#76d8ff',
    watchtower: '#ffd36a',
    harbor: '#d49a54',
};

export class Minimap {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = MINIMAP_SIZE;
        this.canvas.height = MINIMAP_SIZE;
        this.canvas.className = 'content__minimap';
        this.canvas.style.cursor = 'crosshair';
        this.canvas.style.zIndex = '10';
        this.ctx = this.canvas.getContext('2d');
        this.scale = MINIMAP_SIZE / MAP_SIZE;
        this.onNavigate = null;
        this._staticLayer = null;
        this._staticLayerKey = '';
        this._cachedBuildingsSignature = '';
        this._cachedBuildingsMap = null;
        this._cachedBuildingsCount = -1;

        this.canvas.addEventListener('click', this._onClick.bind(this));
        this.canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
    }

    attach(container) {
        container.appendChild(this.canvas);
    }

    detach() {
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this._staticLayer = null;
        this._staticLayerKey = '';
    }

    _onClick(e) {
        if (!this.onNavigate) return;
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const tileX = mx / this.scale;
        const tileY = my / this.scale;
        this.onNavigate(tileX, tileY);
    }

    _onMouseMove(e) {
        this.canvas.style.cursor = 'crosshair';
    }

    draw(world, camera, mainCanvas, layers = {}) {
        this._ensureStaticLayer(world, layers);
        const ctx = this.ctx;
        ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        if (this._staticLayer) {
            ctx.drawImage(this._staticLayer, 0, 0);
        }

        // Agents
        for (const agent of world.agents.values()) {
            const isSelected = layers.selectedAgent?.id === agent.id;
            const statusColor = agent.status === 'working' ? THEME.working :
                agent.status === 'waiting' ? THEME.waiting : THEME.idle;
            const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
            const x = agent.position.tileX * this.scale;
            const y = agent.position.tileY * this.scale;
            const radius = isSelected ? 3.2 : identity.modelTier === 'apex' ? 2.7 : 2.2;
            ctx.fillStyle = identity.minimapColor || (agent.provider === 'codex' ? '#7be3d7' :
                agent.provider === 'claude' ? '#f2d36b' :
                    agent.provider === 'gemini' ? '#b7ccff' :
                        statusColor);
            if (identity.modelClass === 'spark') {
                ctx.beginPath();
                ctx.moveTo(x, y - radius - 1);
                ctx.lineTo(x + radius, y);
                ctx.lineTo(x + 1, y);
                ctx.lineTo(x + radius - 1, y + radius + 1);
                ctx.lineTo(x - radius, y + 1);
                ctx.lineTo(x - 1, y);
                ctx.closePath();
                ctx.fill();
            } else if (identity.modelClass === 'gpt55') {
                ctx.beginPath();
                ctx.moveTo(x, y - radius - 1);
                ctx.lineTo(x + radius + 1, y);
                ctx.lineTo(x, y + radius + 1);
                ctx.lineTo(x - radius - 1, y);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.strokeStyle = statusColor;
            ctx.lineWidth = 1.1;
            ctx.stroke();
            if (isSelected) {
                ctx.strokeStyle = '#fff1b8';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(x, y, radius + 1.4, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Viewport polygon
        if (camera && mainCanvas) {
            const corners = [
                camera.screenToTile(0, 0),
                camera.screenToTile(mainCanvas.width, 0),
                camera.screenToTile(mainCanvas.width, mainCanvas.height),
                camera.screenToTile(0, mainCanvas.height),
            ];
            ctx.strokeStyle = '#ff4c3a';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            corners.forEach((corner, index) => {
                const x = corner.tileX * this.scale;
                const y = corner.tileY * this.scale;
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.stroke();
        }

        ctx.fillStyle = '#d7b979';
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('N', MINIMAP_SIZE / 2, 10);
        ctx.fillText('S', MINIMAP_SIZE / 2, MINIMAP_SIZE - 4);
        ctx.fillText('W', 8, MINIMAP_SIZE / 2 + 3);
        ctx.fillText('E', MINIMAP_SIZE - 8, MINIMAP_SIZE / 2 + 3);

        ctx.strokeStyle = THEME.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, MINIMAP_SIZE - 1, MINIMAP_SIZE - 1);
    }

    _ensureStaticLayer(world, layers = {}) {
        const buildingsSignature = this._snapshotBuildings(world);
        const waterSize = layers.waterTiles?.size || 0;
        const pathSize = layers.pathTiles?.size || 0;
        const bridgeSize = layers.bridgeTiles?.size || 0;
        const key = `${waterSize}|${pathSize}|${bridgeSize}|${buildingsSignature}`;
        if (this._staticLayer && this._staticLayerKey === key) return;

        this._staticLayer = document.createElement('canvas');
        this._staticLayer.width = MINIMAP_SIZE;
        this._staticLayer.height = MINIMAP_SIZE;
        const staticCtx = this._staticLayer.getContext('2d');

        // Background
        staticCtx.fillStyle = '#392b1d';
        staticCtx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        const parchment = staticCtx.createRadialGradient(
            MINIMAP_SIZE * 0.45,
            MINIMAP_SIZE * 0.42,
            10,
            MINIMAP_SIZE * 0.5,
            MINIMAP_SIZE * 0.5,
            MINIMAP_SIZE * 0.8,
        );
        parchment.addColorStop(0, '#7b6a46');
        parchment.addColorStop(0.68, '#4d3d27');
        parchment.addColorStop(1, '#201811');
        staticCtx.fillStyle = parchment;
        staticCtx.fillRect(3, 3, MINIMAP_SIZE - 6, MINIMAP_SIZE - 6);

        staticCtx.fillStyle = 'rgba(255, 232, 166, 0.06)';
        for (let x = 0; x <= MINIMAP_SIZE; x += this.scale * 5) {
            staticCtx.fillRect(x, 0, 1, MINIMAP_SIZE);
            staticCtx.fillRect(0, x, MINIMAP_SIZE, 1);
        }

        this._drawTileLayer(staticCtx, layers.waterTiles, '#1d5c78', 1.2);
        this._drawTileLayer(staticCtx, layers.pathTiles, '#d1ac6b', 1.3);
        if (layers.bridgeTiles) {
            // _drawTileLayer iterates with `for (const key of layer)`. Set
            // and Array iterators yield keys; Map yields entries. Convert
            // Map to a key Set so the call works either way.
            const bridgeKeys = layers.bridgeTiles instanceof Map
                ? new Set(layers.bridgeTiles.keys())
                : layers.bridgeTiles;
            this._drawTileLayer(staticCtx, bridgeKeys, '#b3854c', 1.4);
        }

        // Buildings
        for (const building of world.buildings.values()) {
            const color = BUILDING_COLORS[building.type] || '#666';
            const x = building.position.tileX * this.scale;
            const y = building.position.tileY * this.scale;
            staticCtx.fillStyle = color;
            staticCtx.beginPath();
            staticCtx.moveTo(x + building.width * this.scale / 2, y);
            staticCtx.lineTo(x + building.width * this.scale, y + building.height * this.scale / 2);
            staticCtx.lineTo(x + building.width * this.scale / 2, y + building.height * this.scale);
            staticCtx.lineTo(x, y + building.height * this.scale / 2);
            staticCtx.closePath();
            staticCtx.fill();
            staticCtx.strokeStyle = '#2a1b10';
            staticCtx.lineWidth = 1;
            staticCtx.stroke();
        }

        this._staticLayerKey = key;
    }

    _snapshotBuildings(world) {
        const buildings = world?.buildings;
        if (!buildings) return '';

        if (this._cachedBuildingsMap === buildings &&
            this._cachedBuildingsCount === buildings.size &&
            this._cachedBuildingsSignature) {
            return this._cachedBuildingsSignature;
        }

        const values = [];
        for (const building of buildings.values()) {
            const pos = building.position || {};
            values.push(`${building.type}|${pos.tileX}|${pos.tileY}|${building.width}|${building.height}`);
        }
        values.sort();
        this._cachedBuildingsSignature = values.join(',');
        this._cachedBuildingsCount = buildings.size;
        this._cachedBuildingsMap = buildings;
        return this._cachedBuildingsSignature;
    }

    _drawTileLayer(ctx, tiles, color, size = 1) {
        if (!tiles) return;
        ctx.fillStyle = color;
        for (const key of tiles) {
            const [x, y] = key.split(',').map(Number);
            ctx.fillRect(x * this.scale, y * this.scale, Math.max(size, this.scale), Math.max(size, this.scale));
        }
    }
}
