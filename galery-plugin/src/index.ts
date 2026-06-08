import type { DiscodrivePlugin } from "@discordrive/plugin-sdk";



const galleryPlugin: DiscodrivePlugin = {
    name: "gallery",
    version: "1.0.0",

    async setup(ctx) {
        // Example: Log when a file is uploaded
        ctx.hooks.on("file:uploaded", (data) => {
            console.log(`File uploaded: ${data.fileId} by user ${data.userId}`);
        });

        ctx.hooks.on("file:deleted", (data) => {
            console.log(`File deleted: ${data.fileId} by user ${data.userId}`);
        });
    },

    async teardown() {
        // Clean up resources if needed
        console.log("Gallery plugin is being torn down.");
    }
    
}

export default galleryPlugin;