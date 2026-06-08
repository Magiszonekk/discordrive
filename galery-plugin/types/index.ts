interface GalleryItem {
    id: string;
    fileId: string;
    tags: Tag[];
    description?: string;
    previewPath?: string;
}

interface Tag{
    id: string;
    name: string;
}

interface Category{
    id: string;
    name: string;
}

interface Folder{
    id: string;
    name: string;
    items: GalleryItem[];
}