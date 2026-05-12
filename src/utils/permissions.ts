import type { UserRole } from '../types';

export function canEdit(role: UserRole): boolean {
  return role === 'admin' || role === 'buyer';
}

export function canDelete(role: UserRole): boolean {
  return role === 'admin';
}

export function canImport(role: UserRole): boolean {
  return role === 'admin' || role === 'buyer';
}
