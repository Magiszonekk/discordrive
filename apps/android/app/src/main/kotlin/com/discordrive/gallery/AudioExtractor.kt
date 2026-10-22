package com.discordrive.gallery

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer

/**
 * Copies a video's audio track into a temporary .m4a WITHOUT transcoding
 * (MediaExtractor → MediaMuxer), so it can be sent to a transcription endpoint.
 * Returns null when the video has no audio track or muxing isn't possible
 * (caller then just analyzes frames without a transcript).
 */
object AudioExtractor {

    // Keep under typical transcription upload limits (e.g. OpenAI ~25 MB).
    private const val MAX_BYTES = 24L * 1024 * 1024
    private const val CHUNK = 256 * 1024

    fun extractAudio(context: Context, asset: MediaAsset): File? {
        val extractor = MediaExtractor()
        var muxer: MediaMuxer? = null
        var out: File? = null
        try {
            context.contentResolver.openFileDescriptor(asset.uri, "r")?.use { pfd ->
                extractor.setDataSource(pfd.fileDescriptor)
            } ?: return null

            var audioTrack = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
                    audioTrack = i; format = f; break
                }
            }
            if (audioTrack < 0 || format == null) return null

            extractor.selectTrack(audioTrack)
            out = File(context.cacheDir, "transcribe_${asset.id}.m4a")
            muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val dstTrack = muxer.addTrack(format)
            muxer.start()

            val buffer = ByteBuffer.allocate(CHUNK)
            val info = MediaCodec.BufferInfo()
            var total = 0L
            while (true) {
                val size = extractor.readSampleData(buffer, 0)
                if (size < 0) break
                info.offset = 0
                info.size = size
                info.presentationTimeUs = extractor.sampleTime
                info.flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
                    MediaCodec.BUFFER_FLAG_KEY_FRAME
                } else {
                    0
                }
                muxer.writeSampleData(dstTrack, buffer, info)
                total += size
                if (total >= MAX_BYTES) break // cap: transcribe the first ~minutes
                extractor.advance()
            }
            muxer.stop()
            return out.takeIf { total > 0 }
        } catch (e: Exception) {
            AppLog.w("AudioExtractor", "audio extract failed for ${asset.displayName}", e)
            out?.delete()
            return null
        } finally {
            runCatching { muxer?.release() }
            runCatching { extractor.release() }
        }
    }
}
