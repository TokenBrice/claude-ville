class Particle {
    constructor(x, y, vx, vy, life, color, size) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.life = life;
        this.maxLife = life;
        this.color = color;
        this.size = size;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += 0.05;
        this.life--;
    }

    get alive() {
        return this.life > 0;
    }

    draw(ctx) {
        const alpha = this.life / this.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
        ctx.globalAlpha = 1;
    }
}

const PARTICLE_PRESETS = {
    footstep: {
        colors: ['#6b5b3a', '#7a6a49', '#5a4a2a'],
        size: [1, 2],
        life: [10, 20],
        speed: [0.2, 0.5],
        gravity: false,
        direction: 'down',
    },
    mining: {
        colors: ['#ffd700', '#ff922b', '#ffec99'],
        size: [2, 4],
        life: [20, 40],
        speed: [0.5, 1.5],
        gravity: true,
        direction: 'up',
    },
    sparkle: {
        colors: ['#ffffff', '#ffd43b', '#ffec99'],
        size: [1, 3],
        life: [15, 30],
        speed: [0.3, 0.8],
        gravity: false,
        direction: 'random',
    },
    torch: {
        colors: ['#ff4500', '#ff6b00', '#ffd700'],
        size: [2, 4],
        life: [15, 30],
        speed: [0.3, 0.8],
        gravity: false,
        direction: 'up',
    },
    smoke: {
        colors: ['#555555', '#777777', '#999999'],
        size: [3, 6],
        life: [40, 80],
        speed: [0.1, 0.3],
        gravity: false,
        direction: 'up',
    },
};

function rand(min, max) {
    return min + Math.random() * (max - min);
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export class ParticleSystem {
    constructor() {
        this.particles = [];
    }

    spawn(type, x, y, count = 3) {
        const preset = PARTICLE_PRESETS[type];
        if (!preset) return;

        for (let i = 0; i < count; i++) {
            const size = rand(preset.size[0], preset.size[1]);
            const life = Math.floor(rand(preset.life[0], preset.life[1]));
            const speed = rand(preset.speed[0], preset.speed[1]);
            const color = pick(preset.colors);

            let vx = 0;
            let vy = 0;

            switch (preset.direction) {
                case 'up':
                    vx = rand(-0.3, 0.3);
                    vy = -speed;
                    break;
                case 'down':
                    vx = rand(-0.3, 0.3);
                    vy = speed * 0.3;
                    break;
                case 'random':
                    const angle = Math.random() * Math.PI * 2;
                    vx = Math.cos(angle) * speed;
                    vy = Math.sin(angle) * speed;
                    break;
            }

            const p = new Particle(x + rand(-3, 3), y + rand(-3, 3), vx, vy, life, color, size);
            if (!preset.gravity) {
                p.update = function () {
                    this.x += this.vx;
                    this.y += this.vy;
                    this.life--;
                };
            }
            this.particles.push(p);
        }
    }

    update() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            this.particles[i].update();
            if (!this.particles[i].alive) {
                this.particles.splice(i, 1);
            }
        }
    }

    draw(ctx) {
        for (const p of this.particles) {
            p.draw(ctx);
        }
    }

    clear() {
        this.particles = [];
    }
}
