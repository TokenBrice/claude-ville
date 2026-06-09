import { MAP_SIZE } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';
import { getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';
import { canvasPixelCount, releaseCanvasBackingStore } from './CanvasBudget.js';
import { worldToTile } from './Projection.js';

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
        this.releaseStaticLayer();
    }

    releaseStaticLayer() {
        releaseCanvasBackingStore(this._staticLayer);
        this._staticLayer = null;
        this._staticLayerKey = '';
    }

    getCanvasBudget() {
        return {
            domPixels: canvasPixelCount(this.canvas),
            volatilePixels: canvasPixelCount(this._staticLayer),
            staticLayerKey: this._staticLayerKey,
        };
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

        this._drawHarborMarkers(ctx, layers.harborPendingRepos);
        this._drawSelectedRoute(ctx, layers.selectedAgent, layers.agentSprites);

        const agentEntries = this._agentMinimapEntries(world, layers.agentSprites, layers.selectedAgent);
        if (agentEntries.length >= 24) this._drawAgentDensityHulls(ctx, agentEntries);
        if (agentEntries.length >= 50) {
            this._drawAgentClusters(ctx, agentEntries);
            for (const entry of agentEntries) {
                if (entry.isSelected) this._drawAgentMarker(ctx, entry);
            }
        } else {
            for (const entry of agentEntries) this._drawAgentMarker(ctx, entry);
        }

        // Viewport polygon
        if (camera && mainCanvas) {
            const corners = camera.getViewportTileBounds?.(0)?.corners || [
                camera.screenToTile(0, 0),
                camera.screenToTile(mainCanvas.clientWidth || mainCanvas.width, 0),
                camera.screenToTile(mainCanvas.clientWidth || mainCanvas.width, mainCanvas.clientHeight || mainCanvas.height),
                camera.screenToTile(0, mainCanvas.clientHeight || mainCanvas.height),
            ];
            ctx.fillStyle = 'rgba(255, 229, 158, 0.13)';
            ctx.strokeStyle = '#ffe59e';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            corners.forEach((corner, index) => {
                const x = corner.tileX * this.scale;
                const y = corner.tileY * this.scale;
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.fill();
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
        const monumentSignature = this._snapshotMonuments(layers.chronicleMonuments);
        const key = `${waterSize}|${pathSize}|${bridgeSize}|${buildingsSignature}|${monumentSignature}`;
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

        this._drawMonumentDots(staticCtx, layers.chronicleMonuments);

        this._staticLayerKey = key;
    }

    _snapshotMonuments(monuments) {
        const list = Array.isArray(monuments) ? monuments : [];
        return list
            .map(monument => `${monument.kind || ''}|${monument.tileX}|${monument.tileY}`)
            .sort()
            .join(',');
    }

    _drawMonumentDots(ctx, monuments) {
        const list = Array.isArray(monuments) ? monuments : [];
        for (const monument of list) {
            const x = monument.tileX * this.scale;
            const y = monument.tileY * this.scale;
            ctx.fillStyle = monument.color || '#f7f0a3';
            ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
            ctx.fillStyle = 'rgba(20, 16, 10, 0.7)';
            ctx.fillRect(Math.round(x) + 1, Math.round(y) + 1, 1, 1);
        }
    }

    _drawHarborMarkers(ctx, repos) {
        const list = Array.isArray(repos) ? repos : [];
        if (!list.length) return;
        const totalPending = list.reduce((sum, repo) => sum + (Number(repo.pendingCommits ?? repo.count) || 0), 0);
        const failed = list.reduce((sum, repo) => sum + (Number(repo.failedPushes) || 0), 0);
        const harbor = { x: 33.2 * this.scale, y: 20.4 * this.scale };
        const lagoon = { x: 16.5 * this.scale, y: 8.6 * this.scale };
        const radius = Math.min(7, 3 + Math.sqrt(totalPending));

        ctx.save();
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = failed > 0 ? '#ff7d68' : '#f2d36b';
        ctx.strokeStyle = failed > 0 ? '#fff0d0' : '#5b3519';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(harbor.x, harbor.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (list.some(repo => (repo.waitingZone || '') === 'commit-lagoon' || Number(repo.storageCommits) > 0)) {
            ctx.fillStyle = 'rgba(118, 216, 255, 0.82)';
            ctx.fillRect(lagoon.x - 3, lagoon.y - 3, 6, 6);
        }
        ctx.restore();
    }

    _drawSelectedRoute(ctx, selectedAgent, agentSprites) {
        const sprite = selectedAgent?.id ? agentSprites?.get?.(selectedAgent.id) : null;
        if (!sprite) return;
        const points = [this._worldToMinimap(sprite.x, sprite.y)];
        const waypoints = Array.isArray(sprite.waypoints) ? sprite.waypoints.slice(0, 8) : [];
        for (const waypoint of waypoints) {
            points.push(this._worldToMinimap(waypoint.x, waypoint.y));
        }
        if (Number.isFinite(Number(sprite.targetX)) && Number.isFinite(Number(sprite.targetY))) {
            points.push(this._worldToMinimap(sprite.targetX, sprite.targetY));
        }
        if (points.length < 2) return;

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 241, 184, 0.78)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        points.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        const end = points[points.length - 1];
        ctx.fillStyle = '#fff1b8';
        ctx.fillRect(end.x - 1.5, end.y - 1.5, 3, 3);
        ctx.restore();
    }

    _agentMinimapEntries(world, agentSprites, selectedAgent) {
        const entries = [];
        for (const agent of world.agents.values()) {
            const isSelected = selectedAgent?.id === agent.id;
            const statusColor = agent.status === 'working' ? THEME.working :
                agent.status === 'waiting' ? THEME.waiting : THEME.idle;
            const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
            const position = this._agentMinimapPosition(agent, agentSprites);
            const color = identity.minimapColor || (agent.provider === 'codex' ? '#7be3d7' :
                agent.provider === 'claude' ? '#f2d36b' :
                    agent.provider === 'gemini' ? '#b7ccff' :
                        agent.provider === 'kimi' ? '#ff9f7a' :
                            statusColor);
            entries.push({
                agent,
                identity,
                isSelected,
                statusColor,
                color,
                x: position.tileX * this.scale,
                y: position.tileY * this.scale,
                radius: isSelected ? 3.2 : identity.modelTier === 'mythic' ? 3.0 : identity.modelTier === 'apex' ? 2.7 : 2.2,
            });
        }
        return entries;
    }

    _drawAgentMarker(ctx, entry) {
        const { identity, x, y, radius, color, statusColor, isSelected } = entry;
        ctx.fillStyle = color;
        if (identity.modelClass === 'haiku') {
            ctx.fillStyle = identity.minimapColor || '#ffd47a';
            ctx.beginPath();
            ctx.arc(x, y, 1.5, 0, Math.PI * 2);
            ctx.fill();
        } else if (identity.modelClass === 'spark') {
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

    _drawAgentDensityHulls(ctx, entries) {
        const clusters = this._clusterAgentEntries(entries, entries.length >= 100 ? 12 : 9);
        const minCount = entries.length >= 50 ? 4 : 3;
        ctx.save();
        for (const cluster of clusters) {
            if (cluster.count < minCount) continue;
            const radius = Math.min(13, 3.5 + Math.sqrt(cluster.count) * 1.9);
            ctx.fillStyle = 'rgba(118, 216, 255, 0.12)';
            ctx.strokeStyle = 'rgba(255, 241, 184, 0.34)';
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.arc(cluster.x, cluster.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawAgentClusters(ctx, entries) {
        const clusters = this._clusterAgentEntries(entries, entries.length >= 100 ? 9 : 7);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '6px "Press Start 2P", monospace';
        for (const cluster of clusters) {
            if (cluster.count <= 1) {
                const entry = cluster.entries[0];
                if (!entry || entry.isSelected) continue;
                ctx.fillStyle = entry.color;
                ctx.globalAlpha = 0.76;
                ctx.beginPath();
                ctx.arc(entry.x, entry.y, 1.4, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
                continue;
            }
            const radius = Math.min(10, 2.5 + Math.sqrt(cluster.count) * 1.45);
            ctx.fillStyle = this._clusterStatusColor(cluster);
            ctx.strokeStyle = cluster.selected ? '#fff1b8' : 'rgba(24, 18, 12, 0.82)';
            ctx.lineWidth = cluster.selected ? 1.2 : 0.9;
            ctx.beginPath();
            ctx.arc(cluster.x, cluster.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (cluster.count >= 10) {
                ctx.fillStyle = '#24170f';
                ctx.fillText(String(Math.min(cluster.count, 99)), cluster.x, cluster.y + 0.4);
            }
        }
        ctx.restore();
    }

    _clusterAgentEntries(entries, cellSize) {
        const groups = new Map();
        for (const entry of entries) {
            const key = `${Math.floor(entry.x / cellSize)},${Math.floor(entry.y / cellSize)}`;
            const group = groups.get(key) || {
                entries: [],
                count: 0,
                sumX: 0,
                sumY: 0,
                working: 0,
                waiting: 0,
                idle: 0,
                selected: false,
            };
            group.entries.push(entry);
            group.count++;
            group.sumX += entry.x;
            group.sumY += entry.y;
            group.selected = group.selected || entry.isSelected;
            if (entry.agent.status === 'working') group.working++;
            else if (entry.agent.status === 'waiting') group.waiting++;
            else group.idle++;
            groups.set(key, group);
        }
        return Array.from(groups.values())
            .map(group => ({
                ...group,
                x: group.sumX / group.count,
                y: group.sumY / group.count,
            }))
            .sort((a, b) => (b.count - a.count) || (a.x - b.x));
    }

    _clusterStatusColor(cluster) {
        if ((cluster.working || 0) >= Math.max(cluster.waiting || 0, cluster.idle || 0)) return 'rgba(121, 217, 117, 0.78)';
        if ((cluster.waiting || 0) >= (cluster.idle || 0)) return 'rgba(223, 140, 63, 0.78)';
        return 'rgba(134, 191, 224, 0.74)';
    }

    _agentMinimapPosition(agent, agentSprites) {
        const sprite = agentSprites?.get?.(agent.id);
        if (sprite && Number.isFinite(sprite.x) && Number.isFinite(sprite.y)) {
            const { tileX, tileY } = this._worldToTile(sprite.x, sprite.y);
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) {
                return {
                    tileX: Math.max(0, Math.min(MAP_SIZE, tileX)),
                    tileY: Math.max(0, Math.min(MAP_SIZE, tileY)),
                };
            }
        }
        const position = agent?.position || {};
        return {
            tileX: Number.isFinite(position.tileX) ? position.tileX : 0,
            tileY: Number.isFinite(position.tileY) ? position.tileY : 0,
        };
    }

    _worldToMinimap(worldX, worldY) {
        const tile = this._worldToTile(worldX, worldY);
        return {
            x: Math.max(0, Math.min(MINIMAP_SIZE, tile.tileX * this.scale)),
            y: Math.max(0, Math.min(MINIMAP_SIZE, tile.tileY * this.scale)),
        };
    }

    _worldToTile(worldX, worldY) {
        return worldToTile(worldX, worldY);
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
