import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';

const MINIMAP_SIZE = 150;

const BUILDING_COLORS = {
    command: '#c83d2d',
    forge: '#d8843a',
    mine: '#e8c15e',
    taskboard: '#78c6e7',
    chathall: '#88d67e',
    observatory: '#c9903f',
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
        const ctx = this.ctx;
        ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        // Background
        ctx.fillStyle = '#182414';
        ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        ctx.fillStyle = '#314f2b';
        ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        ctx.fillStyle = 'rgba(242, 211, 107, 0.07)';
        for (let x = 0; x <= MINIMAP_SIZE; x += this.scale * 5) {
            ctx.fillRect(x, 0, 1, MINIMAP_SIZE);
            ctx.fillRect(0, x, MINIMAP_SIZE, 1);
        }

        this._drawTileLayer(ctx, layers.waterTiles, '#2a7891', 1.1);
        this._drawTileLayer(ctx, layers.pathTiles, '#9d7d4b', 1.25);

        // Buildings
        for (const building of world.buildings.values()) {
            const color = BUILDING_COLORS[building.type] || '#666';
            const x = building.position.tileX * this.scale;
            const y = building.position.tileY * this.scale;
            ctx.fillStyle = color;
            ctx.fillRect(x, y, building.width * this.scale, building.height * this.scale);
            ctx.strokeStyle = '#2a1b10';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, building.width * this.scale - 1, building.height * this.scale - 1);
        }

        // Agents
        for (const agent of world.agents.values()) {
            const isSelected = layers.selectedAgent?.id === agent.id;
            ctx.fillStyle = agent.provider === 'codex' ? '#7be3d7' :
                agent.provider === 'claude' ? '#f2d36b' :
                    agent.status === 'working' ? THEME.working :
                        agent.status === 'waiting' ? THEME.waiting : THEME.idle;
            ctx.beginPath();
            ctx.arc(
                agent.position.tileX * this.scale,
                agent.position.tileY * this.scale,
                isSelected ? 3.2 : 2.2, 0, Math.PI * 2,
            );
            ctx.fill();
            if (isSelected) {
                ctx.strokeStyle = '#fff1b8';
                ctx.lineWidth = 1;
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

    _drawTileLayer(ctx, tiles, color, size = 1) {
        if (!tiles) return;
        ctx.fillStyle = color;
        for (const key of tiles) {
            const [x, y] = key.split(',').map(Number);
            ctx.fillRect(x * this.scale, y * this.scale, Math.max(size, this.scale), Math.max(size, this.scale));
        }
    }
}
