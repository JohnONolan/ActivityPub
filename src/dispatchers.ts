import {
    Accept,
    Activity,
    Announce,
    Article,
    type Context,
    Create,
    Follow,
    Group,
    Image,
    Like,
    Note,
    Person,
    type Protocol,
    type RequestContext,
    Undo,
    Update,
    importJwk,
    verifyObject,
} from '@fedify/fedify';
import * as Sentry from '@sentry/node';
import type { KnexAccountRepository } from 'account/account.repository.knex';
import type { FollowersService } from 'activitypub/followers.service';
import { v4 as uuidv4 } from 'uuid';
import type { AccountService } from './account/account.service';
import { mapActorToExternalAccountData } from './account/utils';
import { type ContextData, fedify } from './app';
import { ACTOR_DEFAULT_HANDLE } from './constants';
import { isFollowedByDefaultSiteAccount } from './helpers/activitypub/actor';
import { getUserData } from './helpers/user';
import { addToList } from './kv-helpers';
import { lookupActor, lookupObject } from './lookup-helpers';
import type { KnexPostRepository } from './post/post.repository.knex';
import type { PostService } from './post/post.service';
import type { SiteService } from './site/site.service';

export const actorDispatcher = (
    siteService: SiteService,
    accountService: AccountService,
) =>
    async function actorDispatcher(
        ctx: RequestContext<ContextData>,
        handle: string,
    ) {
        if (handle !== ACTOR_DEFAULT_HANDLE) return null;
        const site = await siteService.getSiteByHost(ctx.host);
        if (site === null) return null;

        const account = await accountService.getDefaultAccountForSite(site);

        const person = new Person({
            id: new URL(account.ap_id),
            name: account.name,
            summary: account.bio,
            preferredUsername: account.username,
            icon: account.avatar_url
                ? new Image({
                      url: new URL(account.avatar_url),
                  })
                : null,
            inbox: new URL(account.ap_inbox_url),
            outbox: new URL(account.ap_outbox_url),
            following: new URL(account.ap_following_url),
            followers: new URL(account.ap_followers_url),
            liked: new URL(account.ap_liked_url),
            url: new URL(account.url || account.ap_id),
            publicKeys: (await ctx.getActorKeyPairs(handle)).map(
                (key) => key.cryptographicKey,
            ),
        });

        return person;
    };

export const keypairDispatcher = (
    siteService: SiteService,
    accountService: AccountService,
) =>
    async function keypairDispatcher(
        ctx: Context<ContextData>,
        handle: string,
    ) {
        if (handle !== ACTOR_DEFAULT_HANDLE) return [];
        const site = await siteService.getSiteByHost(ctx.host);
        if (site === null) return [];

        const account = await accountService.getDefaultAccountForSite(site);

        if (!account.ap_public_key) {
            return [];
        }

        if (!account.ap_private_key) {
            return [];
        }

        try {
            return [
                {
                    publicKey: await importJwk(
                        JSON.parse(account.ap_public_key) as JsonWebKey,
                        'public',
                    ),
                    privateKey: await importJwk(
                        JSON.parse(account.ap_private_key) as JsonWebKey,
                        'private',
                    ),
                },
            ];
        } catch (err) {
            ctx.data.logger.warn(`Could not parse keypair for ${handle}`);
            return [];
        }
    };

export function createFollowHandler(accountService: AccountService) {
    return async function handleFollow(
        ctx: Context<ContextData>,
        follow: Follow,
    ) {
        ctx.data.logger.info('Handling Follow');
        if (!follow.id) {
            return;
        }
        const parsed = ctx.parseUri(follow.objectId);
        if (parsed?.type !== 'actor') {
            // TODO Log
            return;
        }
        const sender = await follow.getActor(ctx);
        if (sender === null || sender.id === null) {
            return;
        }

        // Add follow activity to inbox
        const followJson = await follow.toJsonLd();

        ctx.data.globaldb.set([follow.id.href], followJson);
        await addToList(ctx.data.db, ['inbox'], follow.id.href);

        // Record follower in followers list
        const senderJson = await sender.toJsonLd();

        // Store or update sender in global db
        ctx.data.globaldb.set([sender.id.href], senderJson);

        // Record the account of the sender as well as the follow
        const followeeAccount = await accountService.getAccountByApId(
            follow.objectId?.href ?? '',
        );
        if (followeeAccount) {
            let followerAccount = await accountService.getAccountByApId(
                sender.id.href,
            );

            if (!followerAccount) {
                ctx.data.logger.info(
                    `Follower account "${sender.id.href}" not found, creating`,
                );

                followerAccount = await accountService.createExternalAccount(
                    await mapActorToExternalAccountData(sender),
                );
            }

            await accountService.recordAccountFollow(
                followeeAccount,
                followerAccount,
            );
        }

        // Send accept activity to sender
        const acceptId = ctx.getObjectUri(Accept, { id: uuidv4() });
        const accept = new Accept({
            id: acceptId,
            actor: follow.objectId,
            object: follow,
        });
        const acceptJson = await accept.toJsonLd();

        await ctx.data.globaldb.set([accept.id!.href], acceptJson);

        await ctx.sendActivity({ handle: parsed.handle }, sender, accept);
    };
}

export function createAcceptHandler(accountService: AccountService) {
    return async function handleAccept(
        ctx: Context<ContextData>,
        accept: Accept,
    ) {
        ctx.data.logger.info('Handling Accept');
        const parsed = ctx.parseUri(accept.objectId);
        ctx.data.logger.info('Parsed accept object', { parsed });
        if (!accept.id) {
            ctx.data.logger.info('Accept missing id - exit');
            return;
        }

        const sender = await accept.getActor(ctx);
        ctx.data.logger.info('Accept sender', { sender });
        if (sender === null || sender.id === null) {
            ctx.data.logger.info('Sender missing, exit early');
            return;
        }

        const object = await accept.getObject();
        if (object instanceof Follow === false) {
            ctx.data.logger.info('Accept object is not a Follow, exit early');
            return;
        }

        const senderJson = await sender.toJsonLd();
        const acceptJson = await accept.toJsonLd();
        ctx.data.globaldb.set([accept.id.href], acceptJson);
        ctx.data.globaldb.set([sender.id.href], senderJson);
        await addToList(ctx.data.db, ['inbox'], accept.id.href);

        // Record the account of the sender as well as the follow
        const recipient = await (object as Activity).getActor();
        const followerAccount = await accountService.getAccountByApId(
            recipient?.id?.href ?? '',
        );
        if (followerAccount) {
            let followeeAccount = await accountService.getAccountByApId(
                sender.id.href,
            );

            if (!followeeAccount) {
                ctx.data.logger.info(
                    `Accepting account "${sender.id.href}" not found, creating`,
                );

                followeeAccount = await accountService.createExternalAccount(
                    await mapActorToExternalAccountData(sender),
                );
            }

            await accountService.recordAccountFollow(
                followeeAccount,
                followerAccount,
            );
        }
    };
}

export async function handleAnnoucedCreate(
    ctx: Context<ContextData>,
    announce: Announce,
    siteService: SiteService,
    accountService: AccountService,
    postService: PostService,
) {
    ctx.data.logger.info('Handling Announced Create');

    // Validate announced create activity is from a Group as we only support
    // announcements from Groups - See https://codeberg.org/fediverse/fep/src/branch/main/fep/1b12/fep-1b12.md
    const announcer = await announce.getActor(ctx);

    if (!(announcer instanceof Group)) {
        ctx.data.logger.info('Create is not from a Group, exit early');

        return;
    }

    const site = await siteService.getSiteByHost(ctx.host);

    if (!site) {
        throw new Error(`Site not found for host: ${ctx.host}`);
    }

    // Validate that the group is followed
    if (
        !(await isFollowedByDefaultSiteAccount(announcer, site, accountService))
    ) {
        ctx.data.logger.info('Group is not followed, exit early');

        return;
    }

    let create: Create | null = null;

    // Verify create activity
    create = (await announce.getObject()) as Create;

    if (!create.id) {
        ctx.data.logger.info('Create missing id, exit early');

        return;
    }

    if (create.proofId || create.proofIds.length > 0) {
        ctx.data.logger.info('Verifying create with proof(s)');

        if ((await verifyObject(Create, await create.toJsonLd())) === null) {
            ctx.data.logger.info(
                'Create cannot be verified with provided proof(s), exit early',
            );

            return;
        }
    } else {
        ctx.data.logger.info('Verifying create with network lookup');

        const lookupResult = await lookupObject(ctx, create.id);

        if (lookupResult === null) {
            ctx.data.logger.info(
                'Create cannot be verified with network lookup due to inability to lookup object, exit early',
            );

            return;
        }

        if (
            lookupResult instanceof Create &&
            String(create.id) !== String(lookupResult.id)
        ) {
            ctx.data.logger.info(
                'Create cannot be verified with network lookup due to local activity + remote activity ID mismatch, exit early',
            );

            return;
        }

        if (
            lookupResult instanceof Create &&
            lookupResult.id?.origin !== lookupResult.actorId?.origin
        ) {
            ctx.data.logger.info(
                'Create cannot be verified with network lookup due to remote activity + actor origin mismatch, exit early',
            );

            return;
        }

        if (
            (lookupResult instanceof Note || lookupResult instanceof Article) &&
            create.objectId?.href !== lookupResult.id?.href
        ) {
            ctx.data.logger.info(
                'Create cannot be verified with network lookup due to lookup returning Object and ID mismatch, exit early',
            );

            return;
        }

        // If everything checks out, use the remote create activity where we can
        // so that we can guarantee the integrity of the associated object (i.e
        // the object of the annouced activity has not been tampered with). We can
        // only do this if the lookupResult is a Create (which is not always the
        // case depending on the remote server's implementation - i.e WordPress is
        // returning the Note/Article object instead of a Create object).
        if (lookupResult instanceof Create) {
            create = lookupResult;
        }

        if (!create.id) {
            ctx.data.logger.info('Remote create missing id, exit early');

            return;
        }
    }

    // Persist create activity
    const createJson = await create.toJsonLd();
    ctx.data.globaldb.set([create.id.href], createJson);

    if (!create.objectId) {
        ctx.data.logger.info('Create object id missing, exit early');
        return;
    }
    // This handles storing the posts in the posts table
    const post = await postService.getByApId(create.objectId);

    const object = await create.getObject();
    const replyTarget = await object?.getReplyTarget();

    if (replyTarget?.id?.href) {
        const data = await ctx.data.globaldb.get<any>([replyTarget.id.href]);
        const replyTargetAuthor = data?.attributedTo?.id;
        const inboxActor = await getUserData(ctx, 'index');

        if (replyTargetAuthor === inboxActor.id.href) {
            await addToList(ctx.data.db, ['inbox'], create.id.href);
            return;
        }
    }

    await addToList(ctx.data.db, ['inbox'], create.id.href);
}

export const createUndoHandler = (
    accountService: AccountService,
    postRepository: KnexPostRepository,
    postService: PostService,
) =>
    async function handleUndo(ctx: Context<ContextData>, undo: Undo) {
        ctx.data.logger.info('Handling Undo');

        if (!undo.id) {
            ctx.data.logger.info('Undo missing an id - exiting');
            return;
        }

        const object = await undo.getObject();

        if (object instanceof Follow) {
            const follow = object as Follow;
            if (!follow.actorId || !follow.objectId) {
                ctx.data.logger.info('Undo contains invalid Follow - exiting');
                return;
            }

            const unfollower = await accountService.getAccountByApId(
                follow.actorId.href,
            );
            if (!unfollower) {
                ctx.data.logger.info('Could not find unfollower');
                return;
            }
            const unfollowing = await accountService.getAccountByApId(
                follow.objectId.href,
            );
            if (!unfollowing) {
                ctx.data.logger.info('Could not find unfollowing');
                return;
            }

            await ctx.data.globaldb.set([undo.id.href], await undo.toJsonLd());

            await accountService.recordAccountUnfollow(unfollowing, unfollower);

            await addToList(ctx.data.db, ['inbox'], undo.id.href);
        } else if (object instanceof Announce) {
            const sender = await object.getActor(ctx);
            if (sender === null || sender.id === null) {
                ctx.data.logger.info(
                    'Undo announce activity sender missing, exit early',
                );
                return;
            }
            const senderAccount = await accountService.getByApId(sender.id);

            if (object.objectId === null) {
                ctx.data.logger.info(
                    'Undo announce activity object id missing, exit early',
                );
                return;
            }

            if (senderAccount !== null) {
                const originalPost = await postService.getByApId(
                    object.objectId,
                );

                if (originalPost !== null) {
                    originalPost.removeRepost(senderAccount);
                    await postRepository.save(originalPost);
                }
            }
        }

        return;
    };

export function createAnnounceHandler(
    siteService: SiteService,
    accountService: AccountService,
    postService: PostService,
    postRepository: KnexPostRepository,
) {
    return async function handleAnnounce(
        ctx: Context<ContextData>,
        announce: Announce,
    ) {
        ctx.data.logger.info('Handling Announce');

        // Validate announce
        if (!announce.id) {
            ctx.data.logger.info('Invalid Announce - no id');
            return;
        }

        if (!announce.objectId) {
            ctx.data.logger.info('Invalid Announce - no object id');
            return;
        }

        // Check what was announced - If it's an Activity rather than an Object
        // (which can occur if the announcer is a Group - See
        // https://codeberg.org/fediverse/fep/src/branch/main/fep/1b12/fep-1b12.md),
        // we need to forward the announce on to an appropriate handler
        // This routing is something that should be handled by Fedify, but has
        // not yet been implemented - Tracked here: https://github.com/dahlia/fedify/issues/193
        const announced = await lookupObject(ctx, announce.objectId);

        if (announced instanceof Create) {
            return handleAnnoucedCreate(
                ctx,
                announce,
                siteService,
                accountService,
                postService,
            );
        }

        // Validate sender
        const sender = await announce.getActor(ctx);

        if (sender === null || sender.id === null) {
            ctx.data.logger.info('Announce sender missing, exit early');
            return;
        }

        // Lookup announced object - If not found in globalDb, perform network lookup
        let object = null;
        const existing =
            (await ctx.data.globaldb.get([announce.objectId.href])) ?? null;

        if (!existing) {
            ctx.data.logger.info(
                'Announce object not found in globalDb, performing network lookup',
            );
            object = await lookupObject(ctx, announce.objectId);
        }

        // Validate object
        if (!existing && !object) {
            ctx.data.logger.info('Invalid Announce - could not find object');
            return;
        }

        if (object && !object.id) {
            ctx.data.logger.info('Invalid Announce - could not find object id');
            return;
        }

        // Persist announce
        const announceJson = (await announce.toJsonLd()) as {
            object: object | string;
            [key: string]: unknown;
        };

        if (existing) {
            // If the announced object already exists in globalDb, set it on
            // the activity
            announceJson.object = existing;
        }

        // Persist object if not already persisted
        if (!existing && object && object.id) {
            ctx.data.logger.info('Storing object in globalDb');

            const objectJson = await object.toJsonLd();

            if (typeof objectJson === 'object' && objectJson !== null) {
                if (
                    'attributedTo' in objectJson &&
                    typeof objectJson.attributedTo === 'string'
                ) {
                    const actor = await lookupActor(
                        ctx,
                        objectJson.attributedTo,
                    );
                    objectJson.attributedTo = await actor?.toJsonLd();
                }
            }

            ctx.data.globaldb.set([object.id.href], objectJson);

            // Set the full object on the activity
            announceJson.object = objectJson as object;
        }

        ctx.data.globaldb.set([announce.id.href], announceJson);

        let shouldAddToInbox = false;

        const site = await siteService.getSiteByHost(ctx.host);

        if (!site) {
            throw new Error(`Site not found for host: ${ctx.host}`);
        }

        // This will save the account if it doesn't already exist
        const senderAccount = await accountService.getByApId(sender.id);

        if (senderAccount !== null) {
            // This will save the post if it doesn't already exist
            const post = await postService.getByApId(announce.objectId);

            if (post !== null) {
                post.addRepost(senderAccount);
                await postRepository.save(post);
            }
        }

        shouldAddToInbox = await isFollowedByDefaultSiteAccount(
            sender,
            site,
            accountService,
        );

        if (shouldAddToInbox) {
            await addToList(ctx.data.db, ['inbox'], announce.id.href);
            return;
        }
    };
}

export function createLikeHandler(
    accountService: AccountService,
    postRepository: KnexPostRepository,
    postService: PostService,
) {
    return async function handleLike(ctx: Context<ContextData>, like: Like) {
        ctx.data.logger.info('Handling Like');

        // Validate like
        if (!like.id) {
            ctx.data.logger.info('Invalid Like - no id');
            return;
        }

        if (!like.objectId) {
            ctx.data.logger.info('Invalid Like - no object id');
            return;
        }

        if (!like.actorId) {
            ctx.data.logger.info('Invalid Like - no actor id');
            return;
        }

        const account = await accountService.getByApId(like.actorId);
        if (account !== null) {
            const post = await postService.getByApId(like.objectId);

            if (post !== null) {
                post.addLike(account);

                await postRepository.save(post);
            }
        }

        // Validate sender
        const sender = await like.getActor(ctx);

        if (sender === null || sender.id === null) {
            ctx.data.logger.info('Like sender missing, exit early');
            return;
        }

        // Lookup liked object - If not found in globalDb, perform network lookup
        let object = null;
        const existing =
            (await ctx.data.globaldb.get([like.objectId.href])) ?? null;

        if (!existing) {
            ctx.data.logger.info(
                'Like object not found in globalDb, performing network lookup',
            );

            object = await like.getObject();
        }

        // Validate object
        if (!existing && !object) {
            ctx.data.logger.info('Invalid Like - could not find object');
            return;
        }

        if (object && !object.id) {
            ctx.data.logger.info('Invalid Like - could not find object id');
            return;
        }

        // Persist like
        const likeJson = await like.toJsonLd();
        ctx.data.globaldb.set([like.id.href], likeJson);

        // Persist object if not already persisted
        if (!existing && object && object.id) {
            ctx.data.logger.info('Storing object in globalDb');

            const objectJson = await object.toJsonLd();

            ctx.data.globaldb.set([object.id.href], objectJson);
        }

        await addToList(ctx.data.db, ['inbox'], like.id.href);
    };
}

export async function inboxErrorHandler(
    ctx: Context<ContextData>,
    error: unknown,
) {
    Sentry.captureException(error);
    ctx.data.logger.error('Error handling incoming activity: {error}', {
        error,
    });
}

export function createFollowersDispatcher(
    siteService: SiteService,
    accountRepository: KnexAccountRepository,
    followersService: FollowersService,
) {
    return async function dispatchFollowers(
        ctx: Context<ContextData>,
        handle: string,
    ) {
        const site = await siteService.getSiteByHost(ctx.host);
        if (!site) {
            throw new Error(`Site not found for host: ${ctx.host}`);
        }

        const account = await accountRepository.getBySite(site);

        const followers = await followersService.getFollowers(account.id);

        return {
            items: followers,
        };
    };
}

export function createFollowingDispatcher(
    siteService: SiteService,
    accountService: AccountService,
) {
    return async function dispatchFollowing(
        ctx: RequestContext<ContextData>,
        handle: string,
        cursor: string | null,
    ) {
        ctx.data.logger.info('Following Dispatcher');

        const pageSize = Number.parseInt(
            process.env.ACTIVITYPUB_COLLECTION_PAGE_SIZE || '',
        );

        if (Number.isNaN(pageSize)) {
            throw new Error(`Page size: ${pageSize} is not valid`);
        }

        const offset = Number.parseInt(cursor ?? '0');
        let nextCursor: string | null = null;

        const host = ctx.request.headers.get('host')!;
        const site = await siteService.getSiteByHost(host);

        if (!site) {
            throw new Error(`Site not found for host: ${host}`);
        }

        // @TODO: Get account by provided handle instead of default account?
        const siteDefaultAccount =
            await accountService.getDefaultAccountForSite(site);

        const results = await accountService.getFollowingAccounts(
            siteDefaultAccount,
            {
                fields: ['ap_id'],
                limit: pageSize,
                offset,
            },
        );
        const totalFollowing =
            await accountService.getFollowingAccountsCount(siteDefaultAccount);

        nextCursor =
            totalFollowing > offset + pageSize
                ? (offset + pageSize).toString()
                : null;

        ctx.data.logger.info('Following results', { results });

        return {
            items: results.map((result) => new URL(result.ap_id)),
            nextCursor,
        };
    };
}

export function createFollowersCounter(
    siteService: SiteService,
    accountService: AccountService,
) {
    return async function countFollowers(
        ctx: RequestContext<ContextData>,
        handle: string,
    ) {
        const site = await siteService.getSiteByHost(ctx.host);
        if (!site) {
            throw new Error(`Site not found for host: ${ctx.host}`);
        }

        // @TODO: Get account by provided handle instead of default account?
        const siteDefaultAccount =
            await accountService.getDefaultAccountForSite(site);

        return await accountService.getFollowerAccountsCount(
            siteDefaultAccount,
        );
    };
}

export function createFollowingCounter(
    siteService: SiteService,
    accountService: AccountService,
) {
    return async function countFollowing(
        ctx: RequestContext<ContextData>,
        handle: string,
    ) {
        const site = await siteService.getSiteByHost(ctx.host);
        if (!site) {
            throw new Error(`Site not found for host: ${ctx.host}`);
        }

        // @TODO: Get account by provided handle instead of default account?
        const siteDefaultAccount =
            await accountService.getDefaultAccountForSite(site);

        return await accountService.getFollowingAccountsCount(
            siteDefaultAccount,
        );
    };
}

export function followingFirstCursor() {
    return '0';
}

function filterOutboxActivityUris(activityUris: string[]) {
    // Only return Create and Announce activityUris
    return activityUris.filter((uri) => /(create|announce)/.test(uri));
}

export async function outboxDispatcher(
    ctx: RequestContext<ContextData>,
    handle: string,
    cursor: string | null,
) {
    ctx.data.logger.info('Outbox Dispatcher');

    const pageSize = Number.parseInt(
        process.env.ACTIVITYPUB_COLLECTION_PAGE_SIZE || '',
    );

    if (Number.isNaN(pageSize)) {
        throw new Error(`Page size: ${pageSize} is not valid`);
    }

    const offset = Number.parseInt(cursor ?? '0');
    let nextCursor: string | null = null;

    const results = filterOutboxActivityUris(
        (await ctx.data.db.get<string[]>(['outbox'])) || [],
    ).reverse();

    nextCursor =
        results.length > offset + pageSize
            ? (offset + pageSize).toString()
            : null;

    const slicedResults = results.slice(offset, offset + pageSize);

    ctx.data.logger.info('Outbox results', { results: slicedResults });

    const items: Activity[] = await Promise.all(
        slicedResults.map(async (result) => {
            try {
                const thing = await ctx.data.globaldb.get([result]);
                const activity = await Activity.fromJsonLd(thing);

                return activity;
            } catch (err) {
                Sentry.captureException(err);
                ctx.data.logger.error('Error getting outbox activity', {
                    error: err,
                });
                return null;
            }
        }),
    ).then((results) => results.filter((r): r is Activity => r !== null));

    return {
        items,
        nextCursor,
    };
}

export async function outboxCounter(
    ctx: RequestContext<ContextData>,
    handle: string,
) {
    const results = (await ctx.data.db.get<string[]>(['outbox'])) || [];

    return filterOutboxActivityUris(results).length;
}

export function outboxFirstCursor() {
    return '0';
}

export async function likedDispatcher(
    ctx: RequestContext<ContextData>,
    handle: string,
    cursor: string | null,
) {
    ctx.data.logger.info('Liked Dispatcher');

    const db = ctx.data.db;
    const globaldb = ctx.data.globaldb;
    const logger = ctx.data.logger;
    const apCtx = fedify.createContext(ctx.request as Request, {
        db,
        globaldb,
        logger,
    });

    const pageSize = Number.parseInt(
        process.env.ACTIVITYPUB_COLLECTION_PAGE_SIZE || '',
    );

    if (Number.isNaN(pageSize)) {
        throw new Error(`Page size: ${pageSize} is not valid`);
    }

    const offset = Number.parseInt(cursor ?? '0');
    let nextCursor: string | null = null;

    const results = ((await db.get<string[]>(['liked'])) || []).reverse();

    nextCursor =
        results.length > offset + pageSize
            ? (offset + pageSize).toString()
            : null;

    const slicedResults = results.slice(offset, offset + pageSize);

    ctx.data.logger.info('Liked results', { results: slicedResults });

    const items: Like[] = (
        await Promise.all(
            slicedResults.map(async (result) => {
                try {
                    const thing = await globaldb.get<{
                        object:
                            | string
                            | {
                                  [key: string]: any;
                              };
                        [key: string]: any;
                    }>([result]);

                    if (
                        thing &&
                        typeof thing.object !== 'string' &&
                        typeof thing.object.attributedTo === 'string'
                    ) {
                        const actor = await lookupActor(
                            apCtx,
                            thing.object.attributedTo,
                        );

                        if (actor) {
                            const json = await actor.toJsonLd();

                            if (typeof json === 'object' && json !== null) {
                                thing.object.attributedTo = json;
                            }
                        }
                    }

                    const activity = await Like.fromJsonLd(thing);
                    return activity;
                } catch (err) {
                    Sentry.captureException(err);
                    ctx.data.logger.error('Error getting liked activity', {
                        error: err,
                    });
                    return null;
                }
            }),
        )
    ).filter((item): item is Like => item !== null);

    return {
        items,
        nextCursor,
    };
}

export async function likedCounter(
    ctx: RequestContext<ContextData>,
    handle: string,
) {
    const results = (await ctx.data.db.get<string[]>(['liked'])) || [];

    return results.length;
}

export function likedFirstCursor() {
    return '0';
}

export async function articleDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Article, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Article.fromJsonLd(exists);
}

export async function followDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Follow, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Follow.fromJsonLd(exists);
}

export async function acceptDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Accept, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Accept.fromJsonLd(exists);
}

export async function createDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Create, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Create.fromJsonLd(exists);
}

export async function updateDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Update, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Update.fromJsonLd(exists);
}

export async function noteDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Note, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Note.fromJsonLd(exists);
}

export async function likeDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Like, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Like.fromJsonLd(exists);
}

export async function announceDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Announce, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Announce.fromJsonLd(exists);
}

export async function undoDispatcher(
    ctx: RequestContext<ContextData>,
    data: Record<'id', string>,
) {
    const id = ctx.getObjectUri(Undo, data);
    const exists = await ctx.data.globaldb.get([id.href]);
    if (!exists) {
        return null;
    }
    return Undo.fromJsonLd(exists);
}

export async function nodeInfoDispatcher(ctx: RequestContext<ContextData>) {
    return {
        software: {
            name: 'ghost',
            version: { major: 0, minor: 1, patch: 0 },
            homepage: new URL('https://ghost.org/'),
            repository: new URL('https://github.com/TryGhost/Ghost'),
        },
        protocols: ['activitypub'] as Protocol[],
        openRegistrations: false,
        usage: {
            users: {
                total: 1,
            },
            localPosts: 0,
            localComments: 0,
        },
    };
}
