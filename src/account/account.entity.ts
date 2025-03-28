import { randomUUID } from 'node:crypto';
import { BaseEntity } from '../core/base.entity';
import { type CreatePostType, PostType } from '../post/post.entity';
import type { Site } from '../site/site.service';

export interface AccountData {
    id: number;
    uuid: string | null;
    username: string;
    name: string | null;
    bio: string | null;
    avatarUrl: URL | null;
    bannerImageUrl: URL | null;
    site: Site | null;
    apId: URL | null;
    url: URL | null;
    apFollowers: URL | null;
}

export type AccountSite = {
    id: number;
    host: string;
};

export class Account extends BaseEntity {
    public readonly uuid: string;
    public readonly url: URL;
    public readonly apId: URL;
    public readonly apFollowers: URL;
    constructor(
        public readonly id: number | null,
        uuid: string | null,
        public readonly username: string,
        public readonly name: string | null,
        public readonly bio: string | null,
        public readonly avatarUrl: URL | null,
        public readonly bannerImageUrl: URL | null,
        private readonly site: AccountSite | null,
        apId: URL | null,
        url: URL | null,
        apFollowers: URL | null,
    ) {
        super(id);
        if (uuid === null) {
            this.uuid = randomUUID();
        } else {
            this.uuid = uuid;
        }
        if (apId === null) {
            this.apId = this.getApId();
        } else {
            this.apId = apId;
        }
        if (apFollowers === null) {
            this.apFollowers = this.getApFollowers();
        } else {
            this.apFollowers = apFollowers;
        }
        if (url === null) {
            this.url = this.apId;
        } else {
            this.url = url;
        }
    }

    get isInternal() {
        return this.site !== null;
    }

    getApId() {
        if (!this.isInternal) {
            throw new Error('Cannot get AP ID for External Accounts');
        }

        return new URL(
            `.ghost/activitypub/users/${this.username}`,
            `${Account.protocol}://${this.site!.host}`,
        );
    }

    getApFollowers() {
        if (!this.isInternal) {
            throw new Error('Cannot get AP Followers for External Accounts');
        }

        return new URL(
            `.ghost/activitypub/followers/${this.username}`,
            `${Account.protocol}://${this.site!.host}`,
        );
    }

    getApIdForPost(post: { type: CreatePostType; uuid: string }) {
        if (!this.isInternal) {
            throw new Error('Cannot get AP ID for External Accounts');
        }

        let type: string;
        switch (post.type) {
            case PostType.Article:
                type = 'article';
                break;
            case PostType.Note:
                type = 'note';
                break;
            default: {
                const exhaustiveCheck: never = post.type;
                throw new Error(`Forgot to handle ${exhaustiveCheck}`);
            }
        }

        return new URL(
            `.ghost/activitypub/${type}/${post.uuid}`,
            `${Account.protocol}://${this.site!.host}`,
        );
    }

    private static protocol: 'http' | 'https' =
        process.env.NODE_ENV === 'testing' ? 'http' : 'https';

    static createFromData(data: AccountData) {
        return new Account(
            data.id,
            data.uuid,
            data.username,
            data.name,
            data.bio,
            data.avatarUrl,
            data.bannerImageUrl,
            data.site,
            data.apId,
            data.url,
            data.apFollowers,
        );
    }
}
