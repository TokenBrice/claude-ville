import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';

const MINIMAP_SIZE = 150;

const BUILDING_COLORS = {
    command: '#8b0000',
    forge: '#ff6b00',
    mine: '#ffd700',
    taskboard: '#4a9eff',
    chathall: '#51cf66',
};

export class Minimap {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = MINIMAP_SIZE;
        this.canvas.height = MINIMAP_SIZE;
        this.canvas.style.cssText = `
            position: absolute;
            bottom: 10px;
            left: 10px;
            border: 1px solid ${THEME.border};
            border-radius: 4px;
            background: rgba(10, 10, 15, 0.85);
            cursor: pointer;
            z-index: 10;
        `;
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

    draw(world, camera, mainCanvas) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        // Background
        ctx.fillStyle = '#0a0f0a';
        ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

        // Terrain approximation (simple green fill)
        ctx.fillStyle = THEME.grass[1];
        ctx.globalAlpha = 0.4;
        ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
        ctx.globalAlpha = 1;

        // Buildings
        for (const building of world.buildings.values()) {
            const color = BUILDING_COLORS[building.type] || '#666';
            ctx.fillStyle = color;
            ctx.fillRect(
                building.position.tileX * this.scale,
                building.position.tileY * this.scale,
                building.width * this.scale,
                building.height * this.scale,
            );
        }

        // Agents
        for (const agent of world.agents.values()) {
            ctx.fillStyle = agent.status === 'working' ? THEME.working :
                agent.status === 'waiting' ? THEME.waiting : THEME.idle;
            ctx.beginPath();
            ctx.arc(
                agent.position.tileX * this.scale,
                agent.position.tileY * this.scale,
                2, 0, Math.PI * 2,
            );
            ctx.fill();
        }

        // Viewport rectangle
        if (camera && mainCanvas) {
            const topLeft = camera.screenToTile(0, 0);
            const bottomRight = camera.screenToTile(mainCanvas.width, mainCanvas.height);
            ctx.strokeStyle = '#ff4444';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(
                topLeft.tileX * this.scale,
                topLeft.tileY * this.scale,
                (bottomRight.tileX - topLeft.tileX) * this.scale,
                (bottomRight.tileY - topLeft.tileY) * this.scale,
            );
        }

        // Border
        ctx.strokeStyle = THEME.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    }
}
