import { Folder, FolderOpen, FileVideo, FileAudio, FileImage, FileArchive, FileText, File } from 'lucide-react'

const cls = {
  folder: 'c-folder',
  video: 'c-video',
  audio: 'c-audio',
  image: 'c-image',
  archive: 'c-archive',
  text: 'c-text',
  file: 'c-file'
}

export default function FileIcon({ kind, size = 20 }) {
  const c = cls[kind] || cls.file
  switch (kind) {
    case 'folder':
      return <Folder size={size} className={c} />
    case 'video':
      return <FileVideo size={size} className={c} />
    case 'audio':
      return <FileAudio size={size} className={c} />
    case 'image':
      return <FileImage size={size} className={c} />
    case 'archive':
      return <FileArchive size={size} className={c} />
    case 'text':
      return <FileText size={size} className={c} />
    default:
      return <File size={size} className={c} />
  }
}

export function FolderIcon({ size = 20 }) {
  return <FolderOpen size={size} className={cls.folder} />
}
