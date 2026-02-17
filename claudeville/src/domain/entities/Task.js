export class Task {
    constructor({ id, subject, description, status, owner, blockedBy, activeForm }) {
        this.id = id;
        this.subject = subject;
        this.description = description;
        this.status = status || 'pending';
        this.owner = owner;
        this.blockedBy = blockedBy || [];
        this.activeForm = activeForm;
    }

    get isBlocked() {
        return this.blockedBy.length > 0;
    }

    get isCompleted() {
        return this.status === 'completed';
    }

    get isInProgress() {
        return this.status === 'in_progress';
    }
}
