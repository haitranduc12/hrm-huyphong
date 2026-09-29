import { supabase } from './supabase';
import { describeDbError } from './dbError';
import { uploadContentType, validateFile } from './documents';
import type { EmployeeDocument, EmployeeDocumentType } from '@/types';

export const EMPLOYEE_DOCUMENTS_BUCKET = 'employee-documents';
export const EMPLOYEE_DOCUMENT_TYPE_LABELS: Record<EmployeeDocumentType, string> = {
  CV: 'CV / Sơ yếu lý lịch', IDENTITY: 'Giấy tờ tùy thân', CONTRACT: 'Hợp đồng lao động',
  DEGREE: 'Bằng cấp', CERTIFICATE: 'Chứng chỉ', HEALTH: 'Hồ sơ sức khỏe', OTHER: 'Tài liệu khác',
};

const cleanFileName = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(-80);

export async function listEmployeeDocuments(employeeId: string) {
  const { data, error } = await supabase.from('employee_documents').select('*').eq('employee_id', employeeId).order('created_at', { ascending: false });
  return { data: (data || []) as EmployeeDocument[], error: error ? describeDbError(error) : undefined };
}

export async function uploadEmployeeDocument(input: {
  employeeId: string; uploadedBy: string; file: File; documentType: EmployeeDocumentType;
  title: string; documentNumber?: string; issueDate?: string; expiryDate?: string; note?: string;
}) {
  const invalid = validateFile(input.file);
  if (invalid) return { error: invalid };
  const path = `${input.employeeId}/${crypto.randomUUID()}-${cleanFileName(input.file.name)}`;
  const { error: uploadError } = await supabase.storage.from(EMPLOYEE_DOCUMENTS_BUCKET).upload(path, input.file, { contentType: uploadContentType(input.file.name) });
  if (uploadError) return { error: `Tải file thất bại: ${uploadError.message}` };
  const { error } = await supabase.from('employee_documents').insert({
    employee_id: input.employeeId, document_type: input.documentType, title: input.title.trim(),
    document_number: input.documentNumber?.trim() || null, issue_date: input.issueDate || null,
    expiry_date: input.expiryDate || null, storage_path: path, file_name: input.file.name,
    mime_type: uploadContentType(input.file.name), size_bytes: input.file.size,
    note: input.note?.trim() || null, uploaded_by: input.uploadedBy,
  } as never);
  if (error) {
    await supabase.storage.from(EMPLOYEE_DOCUMENTS_BUCKET).remove([path]);
    return { error: `Lưu hồ sơ thất bại: ${describeDbError(error)}` };
  }
  return {};
}

export async function getEmployeeDocumentUrl(doc: EmployeeDocument, download = false) {
  const { data, error } = await supabase.storage.from(EMPLOYEE_DOCUMENTS_BUCKET).createSignedUrl(doc.storage_path, 60, { download: download ? doc.file_name : false });
  return { url: data?.signedUrl, error: error ? describeDbError(error) : undefined };
}

export async function deleteEmployeeDocument(doc: EmployeeDocument) {
  const { error: fileError } = await supabase.storage.from(EMPLOYEE_DOCUMENTS_BUCKET).remove([doc.storage_path]);
  if (fileError) return { error: `Xóa file thất bại: ${fileError.message}` };
  const { error } = await supabase.from('employee_documents').delete().eq('id', doc.id);
  return { error: error ? describeDbError(error) : undefined };
}
