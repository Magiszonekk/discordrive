package com.discordrive.gallery

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.RecyclerView

class GalleryAdapter(
    private val onClick: (MediaAsset) -> Unit,
    private val onLongClick: ((MediaAsset) -> Unit)? = null,
) : RecyclerView.Adapter<GalleryAdapter.Holder>() {

    private var assets: List<MediaAsset> = emptyList()
    private var syncedAssetIds: Set<Long> = emptySet()
    private var selectionMode = false
    private var selectedIds: Set<Long> = emptySet()

    fun submit(newAssets: List<MediaAsset>, newSyncedIds: Set<Long>) {
        assets = newAssets
        syncedAssetIds = newSyncedIds
        notifyDataSetChanged()
    }

    /** Google-Photos-style selection: checked items shrink over an accent frame. */
    fun setSelection(mode: Boolean, ids: Set<Long>) {
        selectionMode = mode
        selectedIds = ids
        notifyDataSetChanged()
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val thumb: ImageView = view.findViewById(R.id.thumb)
        val playIcon: ImageView = view.findViewById(R.id.playIcon)
        val cloudBadge: ImageView = view.findViewById(R.id.cloudBadge)
        val checkBadge: ImageView = view.findViewById(R.id.checkBadge)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_media, parent, false)
        // square cells
        view.layoutParams = view.layoutParams.apply { height = parent.measuredWidth / SPAN_COUNT }
        return Holder(view)
    }

    override fun getItemCount() = assets.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val asset = assets[position]
        ThumbLoader.load(holder.itemView.context, asset, holder.thumb)
        holder.playIcon.visibility = if (asset.isVideo) View.VISIBLE else View.GONE
        holder.cloudBadge.setImageResource(
            if (asset.id in syncedAssetIds) R.drawable.ic_cloud_done else R.drawable.ic_cloud_pending,
        )

        val selected = selectionMode && asset.id in selectedIds
        holder.checkBadge.visibility = if (selectionMode) View.VISIBLE else View.GONE
        holder.checkBadge.setImageResource(if (selected) R.drawable.ic_check_circle else R.drawable.ic_circle_outline)
        val scale = if (selected) 0.82f else 1f
        holder.thumb.scaleX = scale
        holder.thumb.scaleY = scale
        holder.itemView.setBackgroundColor(
            if (selected) holder.itemView.context.getColor(R.color.accent_dim) else 0,
        )

        holder.itemView.setOnClickListener { onClick(asset) }
        onLongClick?.let { handler ->
            holder.itemView.setOnLongClickListener {
                handler(asset)
                true
            }
        }
    }

    companion object {
        const val SPAN_COUNT = 4
    }
}
