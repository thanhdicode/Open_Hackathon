import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { EmptyState, Skeleton } from "../../components/ui";
import { useJourney } from "../../context/JourneyContext";
import { useNav } from "../../context/NavContext";
import { deletePost, loadPost, toggleReaction, toggleSavePost } from "../../lib/appwrite/community";
import { loadPlaces } from "../../lib/appwrite/explore";
import { useCurrentUserId } from "../../lib/phase5/use-user";
import { translateText } from "../../lib/phase5/translate";
import type { CommunityPost } from "../../lib/phase5/contract";
import { PostDetail } from "./PostDetail";

/**
 * A community post opened as a screen rather than inside Connect.
 *
 * WHY THIS EXISTS
 *
 * The post ↔ place bridge has to work in both directions. Connect → map already
 * worked, because Connect owns its own post detail. Map → Connect did not: the
 * place sheet could list a student's story but had no way to open it, because
 * Connect's detail view is internal state and `setTab` clears the navigation
 * stack.
 *
 * A dedicated screen makes the reverse direction a first-class route instead of
 * a special case inside Connect, and it means a post opened from the map behaves
 * identically to one opened from the feed — same interactions, same permissions,
 * same safety controls.
 */
export function CommunityPostScreen({ postId, onBack }: { postId: string; onBack: () => void }) {
  const { journey } = useJourney();
  const nav = useNav();
  const { userId } = useCurrentUserId();
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [failed, setFailed] = useState(false);
  const [placeName, setPlaceName] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setPost(null);
    setFailed(false);
    loadPost(postId, userId).then((result) => {
      if (cancelled) return;
      if (result.ok) setPost(result.value);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [postId, userId]);

  useEffect(() => {
    if (!post?.placeId) return;
    let cancelled = false;
    // Resolved from the same place table Explore uses, so the name on the card
    // and the name on the map can never disagree.
    void loadPlaces({ countryCode: post.countryCode }).then((result) => {
      if (cancelled || !result.ok) return;
      setPlaceName(result.value.find((place) => place.id === post.placeId)?.name);
    });
    return () => {
      cancelled = true;
    };
  }, [post?.placeId, post?.countryCode]);

  async function react() {
    if (!post || !userId) return;
    const snapshot = post;
    const next = { ...post, viewerReacted: !post.viewerReacted, reactionCount: Math.max(0, post.reactionCount + (post.viewerReacted ? -1 : 1)) };
    setPost(next);
    const result = await toggleReaction(post.id, userId, post.viewerReacted);
    if (!result.ok) {
      setPost(snapshot);
      return;
    }
    setPost((current) => (current ? { ...current, viewerReacted: result.value.reacted } : current));
  }

  async function save() {
    if (!post || !userId) return;
    const snapshot = post;
    const next = { ...post, viewerSaved: !post.viewerSaved, saveCount: Math.max(0, post.saveCount + (post.viewerSaved ? -1 : 1)) };
    setPost(next);
    const result = await toggleSavePost(post.id, userId, post.viewerSaved);
    if (!result.ok) {
      setPost(snapshot);
      return;
    }
    setPost((current) => (current ? { ...current, viewerSaved: result.value.saved } : current));
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Post" onBack={onBack} />
      <Scroll className="px-5 py-4">
        {!post && !failed && (
          <div className="space-y-3">
            <Skeleton className="h-[220px] w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {failed && (
          <EmptyState
            icon="alert"
            title="This post is not available"
            body="It may have been deleted, or it may not be shared with you."
            action="Back to the map"
            onAction={onBack}
          />
        )}

        {post && (
          <PostDetail
            post={post}
            userId={userId}
            placeName={placeName}
            onBack={onBack}
            onToggleReaction={() => void react()}
            onToggleSave={() => void save()}
            onTranslate={() => translateText(post.body, journey)}
            onOpenOnMap={
              post.placeId
                ? () => {
                    nav.focusPlace(post.placeId!);
                  }
                : undefined
            }
            onBlocked={() => onBack()}
            onDeletePost={
              userId && userId === post.authorId
                ? async () => {
                    const result = await deletePost(post.id);
                    if (result.ok) {
                      onBack();
                      return { ok: true };
                    }
                    return { ok: false, message: result.message };
                  }
                : undefined
            }
          />
        )}
      </Scroll>
    </div>
  );
}
