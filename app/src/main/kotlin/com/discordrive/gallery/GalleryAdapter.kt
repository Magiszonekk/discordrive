package com.discordrive.gallery

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.RecyclerView

class GalleryAdapter(
    private val onClick: (MediaAsset) -> Unit,
) : RecyclerView.Adapter<GalleryAdapter.Holder>() {

    private var assets: List<MediaAsset> = emptyList()
    private var syncedAssetIds: Set<Long> = emptySet()

    fun submit(newAssets: List<MediaAsset>, newSyncedIds: Set<Long>) {
        assets = newAssets
        syncedAssetIds = newSyncedIds
        notifyDataSetChanged()
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val thumb: ImageView = view.findViewById(R.id.thumb)
        val playIcon: ImageView = view.findViewById(R.id.playIcon)
        val cloudBadge: ImageView = view.findViewById(R.id.cloudBadge)
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
        holder.itemView.setOnClickListener { onClick(asset) }
    }

    companion object {
        const val SPAN_COUNT = 4
    }
}
