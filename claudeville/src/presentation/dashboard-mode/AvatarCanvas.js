/**
 * Mini character avatar canvas for the dashboard
 * Static recreation of AgentSprite drawing logic
 */
export class AvatarCanvas {
    constructor(agent) {
        this.agent = agent;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 36;
        this.canvas.height = 48;
        this.canvas.style.imageRendering = 'pixelated';
        this.draw();
    }

    draw() {
        const ctx = this.canvas.getContext('2d');
        const w = this.canvas.width;
        const h = this.canvas.height;
        const app = this.agent.appearance;

        ctx.clearRect(0, 0, w, h);
        ctx.save();
        ctx.translate(w / 2, h / 2 + 4);

        // Scale up for visibility
        const scale = 1.3;
        ctx.scale(scale, scale);

        // Legs
        ctx.strokeStyle = app.pants;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-3, 8);
        ctx.lineTo(-4, 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(3, 8);
        ctx.lineTo(4, 16);
        ctx.stroke();

        // Body
        ctx.fillStyle = app.shirt;
        ctx.fillRect(-5, -2, 10, 12);

        // Arms
        ctx.strokeStyle = app.skin;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-8, 7);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(8, 7);
        ctx.stroke();

        // Head
        ctx.fillStyle = app.skin;
        ctx.beginPath();
        ctx.arc(0, -6, 5, 0, Math.PI * 2);
        ctx.fill();

        // Hair
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
        }

        // Eyes
        ctx.fillStyle = '#000';
        switch (app.eyeStyle) {
            case 'normal':
                ctx.fillRect(-3, -7, 2, 2);
                ctx.fillRect(1, -7, 2, 2);
                break;
            case 'happy':
                ctx.lineWidth = 0.8;
                ctx.strokeStyle = '#000';
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

        // Accessory
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

        ctx.restore();
    }
}
