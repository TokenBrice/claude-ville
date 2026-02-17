const SKIN_COLORS = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524'];
const SHIRT_COLORS = ['#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#20c997'];
const HAIR_COLORS = ['#2c1810', '#4a3728', '#8b6914', '#c9a96e', '#d63c3c', '#1a1a2e'];
const HAIR_STYLES = ['short', 'long', 'spiky', 'bald', 'mohawk'];
const PANTS_COLORS = ['#2d3436', '#1e3a5f', '#4a4a4a', '#2c3e50', '#1a1a2e'];
const ACCESSORIES = ['none', 'crown', 'glasses', 'headphones', 'hat'];
const EYE_STYLES = ['normal', 'happy', 'determined', 'sleepy'];

export class Appearance {
    constructor({ skin, shirt, hair, hairStyle, pants, accessory, eyeStyle }) {
        this.skin = skin;
        this.shirt = shirt;
        this.hair = hair;
        this.hairStyle = hairStyle;
        this.pants = pants;
        this.accessory = accessory;
        this.eyeStyle = eyeStyle;
    }

    static fromHash(id) {
        const hash = Appearance.hashCode(id);
        return new Appearance({
            skin: SKIN_COLORS[Math.abs(hash) % SKIN_COLORS.length],
            shirt: SHIRT_COLORS[Math.abs(hash >> 4) % SHIRT_COLORS.length],
            hair: HAIR_COLORS[Math.abs(hash >> 8) % HAIR_COLORS.length],
            hairStyle: HAIR_STYLES[Math.abs(hash >> 12) % HAIR_STYLES.length],
            pants: PANTS_COLORS[Math.abs(hash >> 16) % PANTS_COLORS.length],
            accessory: ACCESSORIES[Math.abs(hash >> 20) % ACCESSORIES.length],
            eyeStyle: EYE_STYLES[Math.abs(hash >> 24) % EYE_STYLES.length],
        });
    }

    static hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }
}
