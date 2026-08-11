import { Eye } from 'lucide-react'
import type { BlobItem } from '../utils/securityDeleteApi'

const short = (value: string) => value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value

export function SecurityDeleteTable({ items, selectable, selected, onToggle, onPreview, previewEnabled }: {
    items: BlobItem[]
    selectable: boolean
    selected: Set<string>
    onToggle: (blobId: string) => void
    onPreview: (item: BlobItem) => void
    previewEnabled: boolean
}) {
    return <div className="sd-table-wrap"><table className="sd-table">
        <thead><tr>{selectable && <th scope="col">Select</th>}<th scope="col">Blob</th><th scope="col">Object</th><th scope="col">Created</th><th scope="col">State</th><th scope="col">Preview</th></tr></thead>
        <tbody>{items.map(item => {
            const canPreview = previewEnabled && item.state !== 'deleted' && item.state !== 'deleted_external'
            return <tr key={item.blobId}>
                {selectable && <td><input type="checkbox" aria-label={`Select ${item.blobId}`} checked={selected.has(item.blobId)} onChange={() => onToggle(item.blobId)}/></td>}
                <td title={item.blobId}>{short(item.blobId)}</td>
                <td title={item.objectId ?? undefined}>{item.objectId ? short(item.objectId) : 'resolving…'}</td>
                <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                <td><span className={`sd-state sd-state-${item.state}`}>{item.state.replace('_', ' ')}</span></td>
                <td><button className="btn btn-secondary sd-preview-button" disabled={!canPreview} title={!previewEnabled ? 'Account details are still resolving' : undefined} onClick={() => onPreview(item)} aria-label={`Preview ${item.blobId}`}><Eye size={15}/></button></td>
            </tr>
        })}</tbody>
    </table></div>
}
