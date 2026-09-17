import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Avatar, Badge, BottomSheet, Button, Card, EmptyState, Notice, Skeleton, Toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { addComment, deleteComment, loadComments } from "../../lib/appwrite/community";
import { blockUser } from "../../lib/appwrite/blocks";
import { reportContent } from "../../lib/appwrite/social";
import { REPORT_REASONS, type CommunityPost, type PostComment } from "../../lib/phase5/contract";
import { PostCard, relativeTime } from "./PostCard";

/**
 * Post detail: the post, its comments, and the safety controls.
 *
 * Block and report live here rather than in a global menu because this is the
 * only screen where a student has decided a specific piece of content is the
 * problem. Blocking removes the author from the feed, People discovery and the
 * map's contributor list, which is what "blocked users must disappear" means in
 * practice.
 *
 * Comment creation is optimistic: the row appears the instant the student taps
 * send and is replaced by the server's copy when the write lands. A failed write
 * removes the placeholder and says why, rather than leaving a comment on screen
 * that only the author can see.
 */

export interface PostDetailProps {
  post: CommunityPost;
  userId: string | null;
  placeName?: string;
  onBack: () => void;
  onToggleReaction: () => void;
  onToggleSave: () => void;
  onTranslate: () => Promise<{ ok: boolean; text?: string; message?: string }>;
  onOpenOnMap?: () => void;
  onBlocked: (blockedUserId: string) => void;
  /** Only supplied when the viewer is the author. */
  onDeletePost?: () => Promise<{ ok: boolean; message?: string }>;
}

/** Marks a comment row that exists only in this browser until the write lands. */
const PENDING_PREFIX = "pending:";

export function PostDetail({
  post,
  userId,
  placeName,
  onBack,
  onToggleReaction,
  onToggleSave,
  onTranslate,
  onOpenOnMap,
  onBlocked,
  onDeletePost,
}: PostDetailProps) {
  const [comments, setComments] = useState<PostComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [count, setCount] = useState(post.commentCount);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadComments(post.id).then((result) => {
      if (cancelled) return;
      setComments(result.ok ? result.value : []);
    });
    return () => {
      cancelled = true;
    };
  }, [post.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function send() {
    if (!userId || !draft.trim() || sending) return;
    const body = draft.trim();
    const placeholderId = `${PENDING_PREFIX}${Date.now()}`;

    setSending(true);
    setDraft("");
    setComments((current) => [
      ...(current ?? []),
      {
        id: placeholderId,
        postId: post.id,
        authorId: userId,
        author: { id: userId, displayName: "You", initials: "YO", color: "#111111", isDemoSeed: false },
        body,
        isDemoSeed: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    setCount((current) => current + 1);

    const result = await addComment(post.id, userId, body);
    setSending(false);

    if (!result.ok) {
      // Roll back both the row and the counter. A comment that is visible only
      // to its author is worse than no comment at all.
      setComments((current) => (current ?? []).filter((entry) => entry.id !== placeholderId));
      setCount((current) => Math.max(0, current - 1));
      setDraft(body);
      setToast(result.message);
      return;
    }

    setComments((current) => (current ?? []).map((entry) => (entry.id === placeholderId ? result.value : entry)));
  }

  async function removeComment(comment: PostComment) {
    const snapshot = comments ?? [];
    setComments(snapshot.filter((entry) => entry.id !== comment.id));
    setCount((current) => Math.max(0, current - 1));
    const result = await deleteComment(comment.id);
    if (!result.ok) {
      setComments(snapshot);
      setCount((current) => current + 1);
      setToast(result.message);
    }
  }

  async function doDeletePost() {
    if (!onDeletePost) return;
    setDeleting(true);
    const result = await onDeletePost();
    setDeleting(false);
    setMenuOpen(false);
    if (!result.ok) setToast(result.message ?? "Could not delete this post.");
  }

  async function doBlock() {
    if (!userId) return;
    const ok = await blockUser(userId, post.authorId, post.author.displayName);
    setMenuOpen(false);
    if (!ok) {
      setToast("Could not block this student.");
      return;
    }
    setBlocked(true);
    onBlocked(post.authorId);
    setToast(`${post.author.displayName} is blocked`);
  }

  async function doReport(reason: string) {
    if (!userId) return;
    const result = await reportContent({ reporterId: userId, targetType: "post", targetId: post.id, reason });
    setReportOpen(false);
    setToast(result.ok ? "Report sent for review" : result.message);
  }

  if (blocked) {
    return (
      <div className="flex h-full flex-col bg-canvas">
        <ScreenHeader title="Post" onBack={onBack} />
        <div className="flex flex-1 items-center justify-center px-8">
          <EmptyState icon="check" title="Student blocked" body="Their posts, places and profile are hidden from you. You can undo this in Settings → Blocked students." />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader
        title="Post"
        onBack={onBack}
        right={
          <button onClick={() => setMenuOpen(true)} aria-label="Post options" className="flex h-11 w-11 items-center justify-center text-muted">
            <Icon name="more" size={18} />
          </button>
        }
      />

      <Scroll className="px-5 py-4">
        <PostCard
          post={post}
          placeName={placeName}
          onOpen={() => undefined}
          onToggleReaction={onToggleReaction}
          onToggleSave={onToggleSave}
          onOpenOnMap={onOpenOnMap}
          onTranslate={onTranslate}
        />

        <div className="mt-5">
          <h2 className="mb-3 text-[15px] font-bold text-ink">
            {count} {count === 1 ? "comment" : "comments"}
          </h2>

          {comments === null && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {comments !== null && comments.length === 0 && (
            <EmptyState icon="chat" title="No comments yet" body="Ask what this place is really like." />
          )}

          {comments !== null && comments.length > 0 && (
            <div className="space-y-2.5">
              {comments.map((comment) => {
                const pending = comment.id.startsWith(PENDING_PREFIX);
                const mine = Boolean(userId) && comment.authorId === userId;
                return (
                  <Card key={comment.id} className={`p-3.5 ${pending ? "opacity-70" : ""}`} data-testid="comment-row">
                    <div className="flex items-start gap-2.5">
                      <Avatar initials={comment.author.initials} color={comment.author.color} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-ink">{comment.author.displayName}</span>
                          {comment.isDemoSeed && <Badge tone="muted">Demo</Badge>}
                          {pending && <span className="text-[11px] text-muted">Sending…</span>}
                          <span className="ml-auto text-[11px] text-muted">{pending ? "" : relativeTime(comment.createdAt)}</span>
                          {mine && !pending && (
                            <button
                              onClick={() => void removeComment(comment)}
                              aria-label="Delete your comment"
                              className="flex h-8 w-8 items-center justify-center text-muted"
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          )}
                        </div>
                        <p className="mt-1 text-[13px] leading-relaxed text-ink">{comment.body}</p>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {!userId && (
          <div className="mt-4">
            <Notice tone="warning" icon="info" title="Sign in to comment" body="Comments need a session so replies can be attributed." />
          </div>
        )}
      </Scroll>

      {userId && (
        <div className="flex items-center gap-2 border-t border-line bg-surface px-4 py-3">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Add a comment…"
            aria-label="Add a comment"
            className="min-h-[44px] flex-1 rounded-full bg-canvas px-4 text-[14px] text-ink outline-none placeholder:text-muted"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            aria-label="Send comment"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-white disabled:opacity-40"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
      )}

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Post options">
        <div className="space-y-2">
          {onOpenOnMap && (
            <Button
              variant="outline"
              full
              onClick={() => {
                setMenuOpen(false);
                onOpenOnMap();
              }}
            >
              <Icon name="map" size={16} /> Open on map
            </Button>
          )}
          <Button variant="outline" full onClick={() => { setMenuOpen(false); setReportOpen(true); }}>
            <Icon name="flag" size={16} /> Report this post
          </Button>
          {onDeletePost && (
            <Button variant="danger" full disabled={deleting} onClick={() => void doDeletePost()}>
              <Icon name="trash" size={16} /> {deleting ? "Deleting…" : "Delete your post"}
            </Button>
          )}
          <Button variant="danger" full onClick={() => void doBlock()}>
            <Icon name="close" size={16} /> Block {post.author.displayName}
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet open={reportOpen} onClose={() => setReportOpen(false)} title="Why are you reporting this?">
        <div className="space-y-2">
          {REPORT_REASONS.map((reason) => (
            <Button key={reason.key} variant="outline" full onClick={() => void doReport(reason.key)}>
              {reason.label}
            </Button>
          ))}
        </div>
      </BottomSheet>

      {toast && <Toast text={toast} />}
    </div>
  );
}
