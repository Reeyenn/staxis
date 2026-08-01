export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_authorization_notifications: {
        Row: {
          account_id: string
          authority_version: number
          data_user_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          authority_version: number
          data_user_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          authority_version?: number
          data_user_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_authorization_notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_authorization_state: {
        Row: {
          account_id: string
          authority_mode: string
          authority_version: number
          created_at: string
          cutover_at: string | null
          cutover_reason: string | null
          legacy_scope_hash: string
          normalized_scope_hash: string
          updated_at: string
        }
        Insert: {
          account_id: string
          authority_mode?: string
          authority_version?: number
          created_at?: string
          cutover_at?: string | null
          cutover_reason?: string | null
          legacy_scope_hash?: string
          normalized_scope_hash?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          authority_mode?: string
          authority_version?: number
          created_at?: string
          cutover_at?: string | null
          cutover_reason?: string | null
          legacy_scope_hash?: string
          normalized_scope_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_authorization_state_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_invites: {
        Row: {
          acceptance_claim_token: string | null
          acceptance_claimed_at: string | null
          accepted_at: string | null
          accepted_by: string | null
          covered_property_ids: string[] | null
          created_at: string
          email: string
          expires_at: string
          hotel_id: string
          id: string
          invited_by: string
          membership_scope: string | null
          organization_id: string | null
          role: string
          token_hash: string
        }
        Insert: {
          acceptance_claim_token?: string | null
          acceptance_claimed_at?: string | null
          accepted_at?: string | null
          accepted_by?: string | null
          covered_property_ids?: string[] | null
          created_at?: string
          email: string
          expires_at: string
          hotel_id: string
          id?: string
          invited_by: string
          membership_scope?: string | null
          organization_id?: string | null
          role: string
          token_hash: string
        }
        Update: {
          acceptance_claim_token?: string | null
          acceptance_claimed_at?: string | null
          accepted_at?: string | null
          accepted_by?: string | null
          covered_property_ids?: string[] | null
          created_at?: string
          email?: string
          expires_at?: string
          hotel_id?: string
          id?: string
          invited_by?: string
          membership_scope?: string | null
          organization_id?: string | null
          role?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_invites_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_invites_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      account_lifecycle_intents: {
        Row: {
          abort_reason: string | null
          aborted_at: string | null
          account_id: string
          actor_account_id: string
          actor_auth_user_id: string
          actor_authority_version_snapshot: number | null
          actor_email: string | null
          attempt_count: number
          auth_banned_until_snapshot: string | null
          auth_snapshot_recorded_at: string | null
          auth_user_id_snapshot: string
          committed_at: string | null
          compensates_operation_id: string | null
          created_at: string
          desired_active: boolean
          hotel_id: string
          last_attempt_at: string | null
          last_error: string | null
          operation_id: string
          prior_active: boolean
          processor_lease_expires_at: string | null
          processor_token: string | null
          status: string
          target_authority_version_snapshot: number | null
          target_authorized_property_ids_snapshot: string[] | null
          target_property_access_snapshot: string[]
          target_role_snapshot: string
          updated_at: string
          version: number
        }
        Insert: {
          abort_reason?: string | null
          aborted_at?: string | null
          account_id: string
          actor_account_id: string
          actor_auth_user_id: string
          actor_authority_version_snapshot?: number | null
          actor_email?: string | null
          attempt_count?: number
          auth_banned_until_snapshot?: string | null
          auth_snapshot_recorded_at?: string | null
          auth_user_id_snapshot: string
          committed_at?: string | null
          compensates_operation_id?: string | null
          created_at?: string
          desired_active: boolean
          hotel_id: string
          last_attempt_at?: string | null
          last_error?: string | null
          operation_id: string
          prior_active: boolean
          processor_lease_expires_at?: string | null
          processor_token?: string | null
          status?: string
          target_authority_version_snapshot?: number | null
          target_authorized_property_ids_snapshot?: string[] | null
          target_property_access_snapshot: string[]
          target_role_snapshot: string
          updated_at?: string
          version: number
        }
        Update: {
          abort_reason?: string | null
          aborted_at?: string | null
          account_id?: string
          actor_account_id?: string
          actor_auth_user_id?: string
          actor_authority_version_snapshot?: number | null
          actor_email?: string | null
          attempt_count?: number
          auth_banned_until_snapshot?: string | null
          auth_snapshot_recorded_at?: string | null
          auth_user_id_snapshot?: string
          committed_at?: string | null
          compensates_operation_id?: string | null
          created_at?: string
          desired_active?: boolean
          hotel_id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          operation_id?: string
          prior_active?: boolean
          processor_lease_expires_at?: string | null
          processor_token?: string | null
          status?: string
          target_authority_version_snapshot?: number | null
          target_authorized_property_ids_snapshot?: string[] | null
          target_property_access_snapshot?: string[]
          target_role_snapshot?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "account_lifecycle_intents_compensates_operation_id_fkey"
            columns: ["compensates_operation_id"]
            isOneToOne: false
            referencedRelation: "account_lifecycle_intents"
            referencedColumns: ["operation_id"]
          },
        ]
      }
      account_property_authorization_bridges: {
        Row: {
          account_id: string
          created_at: string
          cutover_organization_id: string | null
          cutover_reason: string
          cutover_relationship_id: string | null
          id: string
          property_id: string
          retired_at: string | null
          retirement_reason: string | null
          source_legacy_scope_hash: string
          status: string
          topology_bound_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          cutover_organization_id?: string | null
          cutover_reason: string
          cutover_relationship_id?: string | null
          id?: string
          property_id: string
          retired_at?: string | null
          retirement_reason?: string | null
          source_legacy_scope_hash: string
          status?: string
          topology_bound_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          cutover_organization_id?: string | null
          cutover_reason?: string
          cutover_relationship_id?: string | null
          id?: string
          property_id?: string
          retired_at?: string | null
          retirement_reason?: string | null
          source_legacy_scope_hash?: string
          status?: string
          topology_bound_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_property_authorization_bridges_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_authorization_bridges_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      account_property_staff_links: {
        Row: {
          account_id: string
          deactivated_at: string | null
          deactivated_by_account_id: string | null
          is_active: boolean
          linked_at: string
          linked_by_account_id: string | null
          property_id: string
          source: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          deactivated_at?: string | null
          deactivated_by_account_id?: string | null
          is_active?: boolean
          linked_at?: string
          linked_by_account_id?: string | null
          property_id: string
          source?: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          deactivated_at?: string | null
          deactivated_by_account_id?: string | null
          is_active?: boolean
          linked_at?: string
          linked_by_account_id?: string | null
          property_id?: string
          source?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_property_staff_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_deactivated_by_account_id_fkey"
            columns: ["deactivated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_linked_by_account_id_fkey"
            columns: ["linked_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_staff_property_fkey"
            columns: ["staff_id", "property_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id", "property_id"]
          },
        ]
      }
      accounts: {
        Row: {
          active: boolean
          ai_cost_tier: string
          created_at: string
          data_user_id: string
          display_name: string
          id: string
          last_seen_at: string | null
          lifecycle_committed_version: number
          lifecycle_desired_active: boolean
          lifecycle_intent_version: number
          password_hash: string | null
          phone: string | null
          preferred_language: string | null
          property_access: string[]
          role: string
          skip_2fa: boolean
          staff_id: string | null
          updated_at: string
          username: string
        }
        Insert: {
          active?: boolean
          ai_cost_tier?: string
          created_at?: string
          data_user_id: string
          display_name: string
          id?: string
          last_seen_at?: string | null
          lifecycle_committed_version?: number
          lifecycle_desired_active?: boolean
          lifecycle_intent_version?: number
          password_hash?: string | null
          phone?: string | null
          preferred_language?: string | null
          property_access?: string[]
          role?: string
          skip_2fa?: boolean
          staff_id?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          active?: boolean
          ai_cost_tier?: string
          created_at?: string
          data_user_id?: string
          display_name?: string
          id?: string
          last_seen_at?: string | null
          lifecycle_committed_version?: number
          lifecycle_desired_active?: boolean
          lifecycle_intent_version?: number
          password_hash?: string | null
          phone?: string | null
          preferred_language?: string | null
          property_access?: string[]
          role?: string
          skip_2fa?: boolean
          staff_id?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log: {
        Row: {
          actor_account_id: string | null
          actor_name: string | null
          actor_role: string | null
          created_at: string
          description: string
          event_category: string
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          property_id: string
          source: string
          source_event_id: string | null
          target_id: string | null
          target_label: string | null
          target_type: string | null
        }
        Insert: {
          actor_account_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          description: string
          event_category: string
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          property_id: string
          source?: string
          source_event_id?: string | null
          target_id?: string | null
          target_label?: string | null
          target_type?: string | null
        }
        Update: {
          actor_account_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          description?: string
          event_category?: string
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          property_id?: string
          source?: string
          source_event_id?: string | null
          target_id?: string | null
          target_label?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_user_id: string | null
          id: string
          metadata: Json
          target_id: string | null
          target_type: string | null
          ts: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_user_id?: string | null
          id?: string
          metadata?: Json
          target_id?: string | null
          target_type?: string | null
          ts?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_user_id?: string | null
          id?: string
          metadata?: Json
          target_id?: string | null
          target_type?: string | null
          ts?: string
        }
        Relationships: []
      }
      admin_hotel_relationship_mutation_requests: {
        Row: {
          actor_account_id: string
          created_at: string
          id: string
          idempotency_key: string
          property_id: string
          request_fingerprint: string
          response: Json
        }
        Insert: {
          actor_account_id: string
          created_at?: string
          id?: string
          idempotency_key: string
          property_id: string
          request_fingerprint: string
          response: Json
        }
        Update: {
          actor_account_id?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          property_id?: string
          request_fingerprint?: string
          response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "admin_hotel_relationship_mutation_request_actor_account_id_fkey"
            columns: ["actor_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_hotel_relationship_mutation_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_actions: {
        Row: {
          action_key: string
          agent_id: string
          contacts_guest: boolean
          created_at: string
          decided_at: string | null
          decided_by: string | null
          describe_en: string | null
          describe_es: string | null
          describe_key: string | null
          describe_params: Json
          exec_idempotency_key: string | null
          id: string
          payload: Json
          property_id: string
          result: Json | null
          run_id: string
          spends_money: boolean
          status: string
        }
        Insert: {
          action_key: string
          agent_id: string
          contacts_guest?: boolean
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          describe_en?: string | null
          describe_es?: string | null
          describe_key?: string | null
          describe_params?: Json
          exec_idempotency_key?: string | null
          id?: string
          payload?: Json
          property_id: string
          result?: Json | null
          run_id: string
          spends_money?: boolean
          status?: string
        }
        Update: {
          action_key?: string
          agent_id?: string
          contacts_guest?: boolean
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          describe_en?: string | null
          describe_es?: string | null
          describe_key?: string | null
          describe_params?: Json
          exec_idempotency_key?: string | null
          id?: string
          payload?: Json
          property_id?: string
          result?: Json | null
          run_id?: string
          spends_money?: boolean
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_actions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_conversations: {
        Row: {
          authorization_hash: string | null
          conversation_kind: string
          created_at: string
          id: string
          last_summarized_at: string | null
          message_count: number
          organization_id: string | null
          prompt_version: string | null
          property_id: string
          role: string
          scope_receipt_id: string | null
          scope_verified_at: string | null
          title: string | null
          unsummarized_message_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          authorization_hash?: string | null
          conversation_kind?: string
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          organization_id?: string | null
          prompt_version?: string | null
          property_id: string
          role: string
          scope_receipt_id?: string | null
          scope_verified_at?: string | null
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          authorization_hash?: string | null
          conversation_kind?: string
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          organization_id?: string | null
          prompt_version?: string | null
          property_id?: string
          role?: string
          scope_receipt_id?: string | null
          scope_verified_at?: string | null
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_conversations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_conversations_archived: {
        Row: {
          archived_at: string
          authorization_hash: string | null
          conversation_kind: string
          created_at: string
          id: string
          last_summarized_at: string | null
          message_count: number
          organization_id: string | null
          prompt_version: string | null
          property_id: string
          role: string
          scope_receipt_id: string | null
          scope_verified_at: string | null
          title: string | null
          unsummarized_message_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string
          authorization_hash?: string | null
          conversation_kind?: string
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          organization_id?: string | null
          prompt_version?: string | null
          property_id: string
          role: string
          scope_receipt_id?: string | null
          scope_verified_at?: string | null
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string
          authorization_hash?: string | null
          conversation_kind?: string
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          organization_id?: string | null
          prompt_version?: string | null
          property_id?: string
          role?: string
          scope_receipt_id?: string | null
          scope_verified_at?: string | null
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_cost_finalize_failures: {
        Row: {
          actual_cost_usd: number
          attempt_count: number
          cached_input_tokens: number | null
          conversation_id: string | null
          created_at: string
          id: string
          last_error: string | null
          model: string | null
          model_id: string | null
          property_id: string
          reservation_id: string
          tokens_in: number | null
          tokens_out: number | null
          user_id: string
        }
        Insert: {
          actual_cost_usd: number
          attempt_count?: number
          cached_input_tokens?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          model?: string | null
          model_id?: string | null
          property_id: string
          reservation_id: string
          tokens_in?: number | null
          tokens_out?: number | null
          user_id: string
        }
        Update: {
          actual_cost_usd?: number
          attempt_count?: number
          cached_input_tokens?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          model?: string | null
          model_id?: string | null
          property_id?: string
          reservation_id?: string
          tokens_in?: number | null
          tokens_out?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_cost_finalize_failures_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_cost_finalize_failures_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_cost_finalize_failures_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_costs: {
        Row: {
          cached_input_tokens: number
          conversation_id: string | null
          cost_usd: number
          created_at: string
          feature: string | null
          id: string
          kind: string
          model: string
          model_id: string | null
          property_id: string
          state: string
          swept_at: string | null
          tokens_in: number
          tokens_out: number
          user_id: string
        }
        Insert: {
          cached_input_tokens?: number
          conversation_id?: string | null
          cost_usd: number
          created_at?: string
          feature?: string | null
          id?: string
          kind?: string
          model: string
          model_id?: string | null
          property_id: string
          state?: string
          swept_at?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id: string
        }
        Update: {
          cached_input_tokens?: number
          conversation_id?: string | null
          cost_usd?: number
          created_at?: string
          feature?: string | null
          id?: string
          kind?: string
          model?: string
          model_id?: string | null
          property_id?: string
          state?: string
          swept_at?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_costs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_costs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_costs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_costs_monthly: {
        Row: {
          built_at: string
          cached_input_tokens: number
          cost_usd: number
          earliest_created_at: string
          feature: string | null
          id: string
          kind: string
          latest_created_at: string
          model: string | null
          month: string
          property_id: string
          row_count: number
          state: string
          swept: boolean
          tokens_in: number
          tokens_out: number
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          built_at?: string
          cached_input_tokens?: number
          cost_usd?: number
          earliest_created_at: string
          feature?: string | null
          id?: string
          kind: string
          latest_created_at: string
          model?: string | null
          month: string
          property_id: string
          row_count?: number
          state: string
          swept: boolean
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          built_at?: string
          cached_input_tokens?: number
          cost_usd?: number
          earliest_created_at?: string
          feature?: string | null
          id?: string
          kind?: string
          latest_created_at?: string
          model?: string | null
          month?: string
          property_id?: string
          row_count?: number
          state?: string
          swept?: boolean
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_costs_monthly_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_decisions: {
        Row: {
          actor_account_id: string | null
          actor_kind: string
          actor_role: string | null
          args_diff: Json | null
          business_date: string
          conversation_id: string | null
          created_at: string
          decision_ms: number | null
          error: string | null
          executed_args: Json | null
          feedback_at: string | null
          feedback_by: string | null
          feedback_note: string | null
          feedback_rating: number | null
          id: string
          model_id: string | null
          occurred_at: string
          outcome_facts: Json | null
          outcome_kind: string | null
          outcome_observed_at: string | null
          pending_action_id: string | null
          prompt_version: string | null
          property_id: string
          proposed_args: Json
          result: Json | null
          state_snapshot: Json
          state_snapshot_hash: string
          surface: string
          tool_name: string
        }
        Insert: {
          actor_account_id?: string | null
          actor_kind: string
          actor_role?: string | null
          args_diff?: Json | null
          business_date: string
          conversation_id?: string | null
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          feedback_at?: string | null
          feedback_by?: string | null
          feedback_note?: string | null
          feedback_rating?: number | null
          id?: string
          model_id?: string | null
          occurred_at?: string
          outcome_facts?: Json | null
          outcome_kind?: string | null
          outcome_observed_at?: string | null
          pending_action_id?: string | null
          prompt_version?: string | null
          property_id: string
          proposed_args?: Json
          result?: Json | null
          state_snapshot: Json
          state_snapshot_hash: string
          surface: string
          tool_name: string
        }
        Update: {
          actor_account_id?: string | null
          actor_kind?: string
          actor_role?: string | null
          args_diff?: Json | null
          business_date?: string
          conversation_id?: string | null
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          feedback_at?: string | null
          feedback_by?: string | null
          feedback_note?: string | null
          feedback_rating?: number | null
          id?: string
          model_id?: string | null
          occurred_at?: string
          outcome_facts?: Json | null
          outcome_kind?: string | null
          outcome_observed_at?: string | null
          pending_action_id?: string | null
          prompt_version?: string | null
          property_id?: string
          proposed_args?: Json
          result?: Json | null
          state_snapshot?: Json
          state_snapshot_hash?: string
          surface?: string
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_decisions_actor_account_id_fkey"
            columns: ["actor_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_feedback_by_fkey"
            columns: ["feedback_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_eval_baselines: {
        Row: {
          cached_input_tokens: number
          case_name: string
          cost_usd: number
          created_at: string
          duration_ms: number | null
          id: string
          model: string
          model_id: string | null
          passed: boolean
          prompt_version: string
          tokens_in: number
          tokens_out: number
        }
        Insert: {
          cached_input_tokens?: number
          case_name: string
          cost_usd: number
          created_at?: string
          duration_ms?: number | null
          id?: string
          model: string
          model_id?: string | null
          passed: boolean
          prompt_version: string
          tokens_in: number
          tokens_out: number
        }
        Update: {
          cached_input_tokens?: number
          case_name?: string
          cost_usd?: number
          created_at?: string
          duration_ms?: number | null
          id?: string
          model?: string
          model_id?: string | null
          passed?: boolean
          prompt_version?: string
          tokens_in?: number
          tokens_out?: number
        }
        Relationships: []
      }
      agent_knowledge_questions: {
        Row: {
          answered_at: string | null
          answered_by_account_id: string | null
          ask_count: number
          category: string
          created_at: string
          equipment_id: string | null
          fact_content: string
          finding_id: string | null
          first_asked_at: string
          id: string
          last_asked_at: string
          last_asked_on: string
          memory_id: string | null
          property_id: string
          question_en: string
          question_es: string
          status: string
          suggested_equipment_name: string | null
          topic: string
          updated_at: string
        }
        Insert: {
          answered_at?: string | null
          answered_by_account_id?: string | null
          ask_count?: number
          category: string
          created_at?: string
          equipment_id?: string | null
          fact_content: string
          finding_id?: string | null
          first_asked_at?: string
          id?: string
          last_asked_at?: string
          last_asked_on: string
          memory_id?: string | null
          property_id: string
          question_en: string
          question_es: string
          status?: string
          suggested_equipment_name?: string | null
          topic: string
          updated_at?: string
        }
        Update: {
          answered_at?: string | null
          answered_by_account_id?: string | null
          ask_count?: number
          category?: string
          created_at?: string
          equipment_id?: string | null
          fact_content?: string
          finding_id?: string | null
          first_asked_at?: string
          id?: string
          last_asked_at?: string
          last_asked_on?: string
          memory_id?: string | null
          property_id?: string
          question_en?: string
          question_es?: string
          status?: string
          suggested_equipment_name?: string | null
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_knowledge_questions_answered_by_account_id_fkey"
            columns: ["answered_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_knowledge_questions_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_knowledge_questions_equipment_same_property_fk"
            columns: ["property_id", "equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["property_id", "id"]
          },
          {
            foreignKeyName: "agent_knowledge_questions_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_knowledge_questions_finding_same_property_fk"
            columns: ["property_id", "finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["property_id", "id"]
          },
          {
            foreignKeyName: "agent_knowledge_questions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory: {
        Row: {
          authoring_organization_id: string | null
          category: string
          confidence: string
          content: string
          created_at: string
          created_by_account_id: string | null
          created_by_name: string | null
          created_by_role: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          last_used_at: string | null
          override_organization_id: string | null
          overrides_company_fact_id: string | null
          property_id: string
          review_state: string
          scope: string
          source: string
          source_conversation_id: string | null
          subject_account_id: string | null
          superseded_by: string | null
          topic: string
          updated_at: string
          use_count: number
        }
        Insert: {
          authoring_organization_id?: string | null
          category: string
          confidence?: string
          content: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_by_role?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          override_organization_id?: string | null
          overrides_company_fact_id?: string | null
          property_id: string
          review_state: string
          scope: string
          source?: string
          source_conversation_id?: string | null
          subject_account_id?: string | null
          superseded_by?: string | null
          topic: string
          updated_at?: string
          use_count?: number
        }
        Update: {
          authoring_organization_id?: string | null
          category?: string
          confidence?: string
          content?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_by_role?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          override_organization_id?: string | null
          overrides_company_fact_id?: string | null
          property_id?: string
          review_state?: string
          scope?: string
          source?: string
          source_conversation_id?: string | null
          subject_account_id?: string | null
          superseded_by?: string | null
          topic?: string
          updated_at?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_authoring_organization_id_fkey"
            columns: ["authoring_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_override_organization_id_fkey"
            columns: ["override_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_overrides_company_fact_id_fkey"
            columns: ["overrides_company_fact_id"]
            isOneToOne: false
            referencedRelation: "company_knowledge"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory_consolidations: {
        Row: {
          conversations_reviewed: number
          cost_usd: number
          created_at: string
          id: string
          learned_count: number
          model: string | null
          model_id: string | null
          operational_learned_count: number
          operational_recap: string | null
          operational_updated_count: number
          property_id: string
          ran_at: string
          recap: string | null
          run_date: string
          updated_count: number
        }
        Insert: {
          conversations_reviewed?: number
          cost_usd?: number
          created_at?: string
          id?: string
          learned_count?: number
          model?: string | null
          model_id?: string | null
          operational_learned_count?: number
          operational_recap?: string | null
          operational_updated_count?: number
          property_id: string
          ran_at?: string
          recap?: string | null
          run_date: string
          updated_count?: number
        }
        Update: {
          conversations_reviewed?: number
          cost_usd?: number
          created_at?: string
          id?: string
          learned_count?: number
          model?: string | null
          model_id?: string | null
          operational_learned_count?: number
          operational_recap?: string | null
          operational_updated_count?: number
          property_id?: string
          ran_at?: string
          recap?: string | null
          run_date?: string
          updated_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_consolidations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_messages: {
        Row: {
          content: string | null
          conversation_id: string
          cost_usd: number | null
          created_at: string
          id: string
          is_error: boolean | null
          is_summarized: boolean
          is_summary: boolean
          model_id: string | null
          model_used: string | null
          prompt_version: string | null
          property_id: string
          role: string
          tokens_in: number | null
          tokens_out: number | null
          tool_args: Json | null
          tool_call_id: string | null
          tool_name: string | null
          tool_result: Json | null
        }
        Insert: {
          content?: string | null
          conversation_id: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          property_id: string
          role: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Update: {
          content?: string | null
          conversation_id?: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          property_id?: string
          role?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_messages_archived: {
        Row: {
          archived_at: string
          content: string | null
          conversation_id: string
          cost_usd: number | null
          created_at: string
          id: string
          is_error: boolean | null
          is_summarized: boolean
          is_summary: boolean
          model_id: string | null
          model_used: string | null
          prompt_version: string | null
          role: string
          tokens_in: number | null
          tokens_out: number | null
          tool_args: Json | null
          tool_call_id: string | null
          tool_name: string | null
          tool_result: Json | null
        }
        Insert: {
          archived_at?: string
          content?: string | null
          conversation_id: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          role: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Update: {
          archived_at?: string
          content?: string | null
          conversation_id?: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          role?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Relationships: []
      }
      agent_nudges: {
        Row: {
          acknowledged_at: string | null
          category: string
          created_at: string
          dedupe_key: string | null
          id: string
          payload: Json
          property_id: string
          severity: string
          status: string
          user_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          category: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          payload: Json
          property_id: string
          severity?: string
          status?: string
          user_id: string
        }
        Update: {
          acknowledged_at?: string | null
          category?: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          payload?: Json
          property_id?: string
          severity?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_nudges_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_nudges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_pending_actions: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          decision_ms: number | null
          error: string | null
          executed_args: Json | null
          expires_at: string
          id: string
          property_id: string
          resolved_at: string | null
          result: Json | null
          resume_claimed_at: string | null
          state_snapshot_hash: string | null
          status: string
          tier: string
          tool_args: Json
          tool_call_id: string
          tool_name: string
          turn_key: string
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          expires_at?: string
          id?: string
          property_id: string
          resolved_at?: string | null
          result?: Json | null
          resume_claimed_at?: string | null
          state_snapshot_hash?: string | null
          status?: string
          tier: string
          tool_args: Json
          tool_call_id: string
          tool_name: string
          turn_key: string
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          expires_at?: string
          id?: string
          property_id?: string
          resolved_at?: string | null
          result?: Json | null
          resume_claimed_at?: string | null
          state_snapshot_hash?: string | null
          status?: string
          tier?: string
          tool_args?: Json
          tool_call_id?: string
          tool_name?: string
          turn_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_pending_actions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_pending_actions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_pending_actions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_prompts: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          notes: string | null
          parent_version: string | null
          pms_family: string | null
          role: string
          version: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          parent_version?: string | null
          pms_family?: string | null
          role: string
          version: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          parent_version?: string | null
          pms_family?: string | null
          role?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_prompts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_reminders: {
        Row: {
          body: string
          canceled_at: string | null
          claim_token: string | null
          claimed_at: string | null
          created_at: string
          created_by_staff_id: string | null
          fire_at: string
          fired_at: string | null
          id: string
          property_id: string
          target_department: string | null
          target_staff_id: string | null
        }
        Insert: {
          body: string
          canceled_at?: string | null
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          fire_at: string
          fired_at?: string | null
          id?: string
          property_id: string
          target_department?: string | null
          target_staff_id?: string | null
        }
        Update: {
          body?: string
          canceled_at?: string | null
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          fire_at?: string
          fired_at?: string | null
          id?: string
          property_id?: string
          target_department?: string | null
          target_staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_reminders_created_by_staff_id_fkey"
            columns: ["created_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_reminders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_reminders_target_staff_id_fkey"
            columns: ["target_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_id: string
          approximations: Json
          as_of_date: string | null
          error: string | null
          event_id: string | null
          finished_at: string | null
          id: string
          inputs_snapshot: Json
          mode: string
          property_id: string
          run_local_date: string
          started_at: string
          status: string
          summary: string | null
          summary_key: string | null
          summary_params: Json
          trigger_source: string
          triggered_by: string | null
        }
        Insert: {
          agent_id: string
          approximations?: Json
          as_of_date?: string | null
          error?: string | null
          event_id?: string | null
          finished_at?: string | null
          id?: string
          inputs_snapshot?: Json
          mode: string
          property_id: string
          run_local_date: string
          started_at?: string
          status?: string
          summary?: string | null
          summary_key?: string | null
          summary_params?: Json
          trigger_source: string
          triggered_by?: string | null
        }
        Update: {
          agent_id?: string
          approximations?: Json
          as_of_date?: string | null
          error?: string | null
          event_id?: string | null
          finished_at?: string | null
          id?: string
          inputs_snapshot?: Json
          mode?: string
          property_id?: string
          run_local_date?: string
          started_at?: string
          status?: string
          summary?: string | null
          summary_key?: string | null
          summary_params?: Json
          trigger_source?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          config: Json
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          last_run_at: string | null
          last_run_local_date: string | null
          name: string
          property_id: string
          status: string
          template_key: string | null
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_run_at?: string | null
          last_run_local_date?: string | null
          name: string
          property_id: string
          status?: string
          template_key?: string | null
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_run_at?: string | null
          last_run_local_date?: string | null
          name?: string
          property_id?: string
          status?: string
          template_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_employee_switches: {
        Row: {
          employee_id: string
          note: string | null
          switched_off: boolean
          switched_off_at: string | null
          switched_off_by: string | null
          updated_at: string
        }
        Insert: {
          employee_id: string
          note?: string | null
          switched_off?: boolean
          switched_off_at?: string | null
          switched_off_by?: string | null
          updated_at?: string
        }
        Update: {
          employee_id?: string
          note?: string | null
          switched_off?: boolean
          switched_off_at?: string | null
          switched_off_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_employee_switches_switched_off_by_fkey"
            columns: ["switched_off_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_feature_config_versions: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          activated_by_email: string | null
          change_reason: string | null
          created_at: string
          created_by: string | null
          created_by_email: string | null
          enabled: boolean
          fallback_model_id: string | null
          fallback_provider: string | null
          feature_key: string
          id: string
          is_active: boolean
          parameters: Json
          parent_id: string | null
          primary_model_id: string
          primary_provider: string
          validated_at: string | null
          validated_by: string | null
          validated_by_email: string | null
          validation_report: Json
          validation_status: string
          version: number
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          activated_by_email?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          created_by_email?: string | null
          enabled?: boolean
          fallback_model_id?: string | null
          fallback_provider?: string | null
          feature_key: string
          id?: string
          is_active?: boolean
          parameters?: Json
          parent_id?: string | null
          primary_model_id: string
          primary_provider: string
          validated_at?: string | null
          validated_by?: string | null
          validated_by_email?: string | null
          validation_report?: Json
          validation_status?: string
          version: number
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          activated_by_email?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          created_by_email?: string | null
          enabled?: boolean
          fallback_model_id?: string | null
          fallback_provider?: string | null
          feature_key?: string
          id?: string
          is_active?: boolean
          parameters?: Json
          parent_id?: string | null
          primary_model_id?: string
          primary_provider?: string
          validated_at?: string | null
          validated_by?: string | null
          validated_by_email?: string | null
          validation_report?: Json
          validation_status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_feature_config_versions_activated_by_fkey"
            columns: ["activated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feature_config_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feature_config_versions_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "ai_feature_config_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feature_config_versions_validated_by_fkey"
            columns: ["validated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_model_catalog: {
        Row: {
          available: boolean
          capabilities: string[]
          display_name: string
          first_seen_at: string
          last_seen_at: string
          max_input_tokens: number | null
          max_output_tokens: number | null
          model_id: string
          pricing: Json | null
          provider: string
          raw_metadata: Json
          released_at: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          available?: boolean
          capabilities?: string[]
          display_name: string
          first_seen_at?: string
          last_seen_at?: string
          max_input_tokens?: number | null
          max_output_tokens?: number | null
          model_id: string
          pricing?: Json | null
          provider: string
          raw_metadata?: Json
          released_at?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          available?: boolean
          capabilities?: string[]
          display_name?: string
          first_seen_at?: string
          last_seen_at?: string
          max_input_tokens?: number | null
          max_output_tokens?: number | null
          model_id?: string
          pricing?: Json | null
          provider?: string
          raw_metadata?: Json
          released_at?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_recommendation_reports: {
        Row: {
          created_by: string | null
          created_by_email: string | null
          generated_at: string
          id: string
          model_used: string
          recommendations: Json
          spend_30d_usd: number
        }
        Insert: {
          created_by?: string | null
          created_by_email?: string | null
          generated_at?: string
          id?: string
          model_used: string
          recommendations?: Json
          spend_30d_usd?: number
        }
        Update: {
          created_by?: string | null
          created_by_email?: string | null
          generated_at?: string
          id?: string
          model_used?: string
          recommendations?: Json
          spend_30d_usd?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_recommendation_reports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      api_limits: {
        Row: {
          count: number
          endpoint: string
          hour_bucket: string
          property_id: string
        }
        Insert: {
          count?: number
          endpoint: string
          hour_bucket: string
          property_id: string
        }
        Update: {
          count?: number
          endpoint?: string
          hour_bucket?: string
          property_id?: string
        }
        Relationships: []
      }
      app_events: {
        Row: {
          event_type: string
          id: string
          metadata: Json
          property_id: string | null
          ts: string
          user_id: string | null
          user_role: string | null
        }
        Insert: {
          event_type: string
          id?: string
          metadata?: Json
          property_id?: string | null
          ts?: string
          user_id?: string | null
          user_role?: string | null
        }
        Update: {
          event_type?: string
          id?: string
          metadata?: Json
          property_id?: string | null
          ts?: string
          user_id?: string | null
          user_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          ai_subscriptions: Json
          id: boolean
          subscription_audit_requested_at: string | null
          two_factor_enabled: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ai_subscriptions?: Json
          id?: boolean
          subscription_audit_requested_at?: string | null
          two_factor_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ai_subscriptions?: Json
          id?: boolean
          subscription_audit_requested_at?: string | null
          two_factor_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      applied_migrations: {
        Row: {
          applied_at: string
          description: string | null
          version: string
        }
        Insert: {
          applied_at?: string
          description?: string | null
          version: string
        }
        Update: {
          applied_at?: string
          description?: string | null
          version?: string
        }
        Relationships: []
      }
      attendance_marks: {
        Row: {
          attended: boolean
          date: string
          marked_at: string
          marked_by: string | null
          notes: string | null
          property_id: string
          staff_id: string
        }
        Insert: {
          attended: boolean
          date: string
          marked_at?: string
          marked_by?: string | null
          notes?: string | null
          property_id: string
          staff_id: string
        }
        Update: {
          attended?: boolean
          date?: string
          marked_at?: string
          marked_by?: string | null
          notes?: string | null
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_marks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_marks_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      authorization_scope_receipts: {
        Row: {
          account_authorization_version: number
          account_id: string
          authority_mode: string
          authorization_hash: string
          authorized_property_ids: string[]
          expires_at: string
          id: string
          organization_access_epoch: number
          organization_id: string
          organization_name: string
          portfolio_catalog: Json
          provenance: Json
          requested_portfolio_id: string | null
          requested_property_ids: string[]
          resolved_at: string
          resolver_version: string
          scope_hash: string
          selected_property_ids: string[]
          selector_type: string
        }
        Insert: {
          account_authorization_version: number
          account_id: string
          authority_mode: string
          authorization_hash: string
          authorized_property_ids: string[]
          expires_at: string
          id?: string
          organization_access_epoch: number
          organization_id: string
          organization_name: string
          portfolio_catalog?: Json
          provenance?: Json
          requested_portfolio_id?: string | null
          requested_property_ids?: string[]
          resolved_at?: string
          resolver_version: string
          scope_hash: string
          selected_property_ids: string[]
          selector_type: string
        }
        Update: {
          account_authorization_version?: number
          account_id?: string
          authority_mode?: string
          authorization_hash?: string
          authorized_property_ids?: string[]
          expires_at?: string
          id?: string
          organization_access_epoch?: number
          organization_id?: string
          organization_name?: string
          portfolio_catalog?: Json
          provenance?: Json
          requested_portfolio_id?: string | null
          requested_property_ids?: string[]
          resolved_at?: string
          resolver_version?: string
          scope_hash?: string
          selected_property_ids?: string[]
          selector_type?: string
        }
        Relationships: []
      }
      callout_events: {
        Row: {
          business_date: string
          created_at: string
          id: string
          impacted_assignments: Json
          leave_timing: string | null
          note: string | null
          property_id: string
          reason: string | null
          redistribute_at: string | null
          redistributed_at: string | null
          reported_at: string
          reported_by: string
          reported_by_user_id: string | null
          revert_outcome: Json | null
          revert_reason: string | null
          reverted_at: string | null
          reverted_by_staff_id: string | null
          reverted_by_user_id: string | null
          staff_id: string
          status: string
          updated_at: string
        }
        Insert: {
          business_date: string
          created_at?: string
          id?: string
          impacted_assignments?: Json
          leave_timing?: string | null
          note?: string | null
          property_id: string
          reason?: string | null
          redistribute_at?: string | null
          redistributed_at?: string | null
          reported_at?: string
          reported_by: string
          reported_by_user_id?: string | null
          revert_outcome?: Json | null
          revert_reason?: string | null
          reverted_at?: string | null
          reverted_by_staff_id?: string | null
          reverted_by_user_id?: string | null
          staff_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          business_date?: string
          created_at?: string
          id?: string
          impacted_assignments?: Json
          leave_timing?: string | null
          note?: string | null
          property_id?: string
          reason?: string | null
          redistribute_at?: string | null
          redistributed_at?: string | null
          reported_at?: string
          reported_by?: string
          reported_by_user_id?: string | null
          revert_outcome?: Json | null
          revert_reason?: string | null
          reverted_at?: string | null
          reverted_by_staff_id?: string | null
          reverted_by_user_id?: string | null
          staff_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "callout_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_events_reverted_by_staff_id_fkey"
            columns: ["reverted_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_events_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      capability_overrides: {
        Row: {
          allowed: boolean
          capability: string
          id: string
          property_id: string
          role: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allowed: boolean
          capability: string
          id?: string
          property_id: string
          role: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allowed?: boolean
          capability?: string
          id?: string
          property_id?: string
          role?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capability_overrides_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capability_overrides_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      capex_line_items: {
        Row: {
          amount_cents: number
          capex_project_id: string
          created_at: string
          id: string
          incurred_date: string | null
          label: string
          property_id: string
          source: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount_cents?: number
          capex_project_id: string
          created_at?: string
          id?: string
          incurred_date?: string | null
          label: string
          property_id: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount_cents?: number
          capex_project_id?: string
          created_at?: string
          id?: string
          incurred_date?: string | null
          label?: string
          property_id?: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capex_line_items_capex_project_id_fkey"
            columns: ["capex_project_id"]
            isOneToOne: false
            referencedRelation: "capex_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capex_line_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      capex_projects: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          approved_by_name: string | null
          attachment_path: string | null
          category: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          decided_at: string | null
          decision_notes: string | null
          description: string | null
          estimated_cost_cents: number
          id: string
          name: string
          pct_complete: number
          property_id: string
          quote_cents: number
          request_type: string
          start_date: string | null
          status: string
          submitted_by: string | null
          submitted_by_name: string | null
          target_date: string | null
          updated_at: string
          vendor: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          approved_by_name?: string | null
          attachment_path?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          decided_at?: string | null
          decision_notes?: string | null
          description?: string | null
          estimated_cost_cents?: number
          id?: string
          name: string
          pct_complete?: number
          property_id: string
          quote_cents?: number
          request_type?: string
          start_date?: string | null
          status?: string
          submitted_by?: string | null
          submitted_by_name?: string | null
          target_date?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          approved_by_name?: string | null
          attachment_path?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          decided_at?: string | null
          decision_notes?: string | null
          description?: string | null
          estimated_cost_cents?: number
          id?: string
          name?: string
          pct_complete?: number
          property_id?: string
          quote_cents?: number
          request_type?: string
          start_date?: string | null
          status?: string
          submitted_by?: string | null
          submitted_by_name?: string | null
          target_date?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capex_projects_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_items: {
        Row: {
          category: string
          created_at: string
          default_vendor_name: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          suggested_par: number | null
          suggested_unit_cost_cents: number | null
          unit: string
        }
        Insert: {
          category: string
          created_at?: string
          default_vendor_name?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          suggested_par?: number | null
          suggested_unit_cost_cents?: number | null
          unit?: string
        }
        Update: {
          category?: string
          created_at?: string
          default_vendor_name?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          suggested_par?: number | null
          suggested_unit_cost_cents?: number | null
          unit?: string
        }
        Relationships: []
      }
      claude_sessions: {
        Row: {
          branch: string | null
          current_tool: string | null
          cwd: string | null
          last_heartbeat: string
          metadata: Json
          session_id: string
          started_at: string
        }
        Insert: {
          branch?: string | null
          current_tool?: string | null
          cwd?: string | null
          last_heartbeat?: string
          metadata?: Json
          session_id: string
          started_at?: string
        }
        Update: {
          branch?: string | null
          current_tool?: string | null
          cwd?: string | null
          last_heartbeat?: string
          metadata?: Json
          session_id?: string
          started_at?: string
        }
        Relationships: []
      }
      claude_usage_log: {
        Row: {
          cache_read_tokens: number
          cache_write_tokens: number
          cost_micros: number
          id: string
          input_tokens: number
          job_id: string | null
          metadata: Json
          model: string
          output_tokens: number
          property_id: string | null
          source: string
          ts: string
          workload: string
        }
        Insert: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_micros?: number
          id?: string
          input_tokens?: number
          job_id?: string | null
          metadata?: Json
          model: string
          output_tokens?: number
          property_id?: string | null
          source?: string
          ts?: string
          workload: string
        }
        Update: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_micros?: number
          id?: string
          input_tokens?: number
          job_id?: string | null
          metadata?: Json
          model?: string
          output_tokens?: number
          property_id?: string | null
          source?: string
          ts?: string
          workload?: string
        }
        Relationships: [
          {
            foreignKeyName: "claude_usage_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_checklist_items: {
        Row: {
          area: string
          created_at: string
          id: string
          is_critical: boolean
          item_en: string
          item_es: string
          sort_order: number
          template_id: string
        }
        Insert: {
          area: string
          created_at?: string
          id?: string
          is_critical?: boolean
          item_en: string
          item_es: string
          sort_order?: number
          template_id: string
        }
        Update: {
          area?: string
          created_at?: string
          id?: string
          is_critical?: boolean
          item_en?: string
          item_es?: string
          sort_order?: number
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_checklist_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "cleaning_checklist_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_checklist_templates: {
        Row: {
          cleaning_type: string
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name_en: string
          name_es: string
          property_id: string | null
          updated_at: string
        }
        Insert: {
          cleaning_type: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name_en: string
          name_es: string
          property_id?: string | null
          updated_at?: string
        }
        Update: {
          cleaning_type?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name_en?: string
          name_es?: string
          property_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_checklist_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_events: {
        Row: {
          completed_at: string
          created_at: string
          date: string
          day_of_stay_raw: number | null
          day_of_week: number | null
          duration_minutes: number
          feature_set_version: string | null
          flag_reason: string | null
          id: string
          minutes_since_shift_start: number | null
          occupancy_at_start: number | null
          property_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          room_floor: number | null
          room_number: string
          room_type: string
          route_position: number | null
          staff_id: string | null
          staff_name: string
          started_at: string
          status: Database["public"]["Enums"]["cleaning_event_status"]
          stayover_day: number | null
          total_checkouts_today: number | null
          total_rooms_assigned_to_hk: number | null
          was_dnd_during_clean: boolean | null
          weather_class: string | null
        }
        Insert: {
          completed_at: string
          created_at?: string
          date: string
          day_of_stay_raw?: number | null
          day_of_week?: number | null
          duration_minutes: number
          feature_set_version?: string | null
          flag_reason?: string | null
          id?: string
          minutes_since_shift_start?: number | null
          occupancy_at_start?: number | null
          property_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          room_floor?: number | null
          room_number: string
          room_type: string
          route_position?: number | null
          staff_id?: string | null
          staff_name: string
          started_at: string
          status?: Database["public"]["Enums"]["cleaning_event_status"]
          stayover_day?: number | null
          total_checkouts_today?: number | null
          total_rooms_assigned_to_hk?: number | null
          was_dnd_during_clean?: boolean | null
          weather_class?: string | null
        }
        Update: {
          completed_at?: string
          created_at?: string
          date?: string
          day_of_stay_raw?: number | null
          day_of_week?: number | null
          duration_minutes?: number
          feature_set_version?: string | null
          flag_reason?: string | null
          id?: string
          minutes_since_shift_start?: number | null
          occupancy_at_start?: number | null
          property_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          room_floor?: number | null
          room_number?: string
          room_type?: string
          route_position?: number | null
          staff_id?: string | null
          staff_name?: string
          started_at?: string
          status?: Database["public"]["Enums"]["cleaning_event_status"]
          stayover_day?: number | null
          total_checkouts_today?: number | null
          total_rooms_assigned_to_hk?: number | null
          was_dnd_during_clean?: boolean | null
          weather_class?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cleaning_events_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_tasks: {
        Row: {
          assignee_id: string | null
          business_date: string
          cleaning_type: string
          completed_at: string | null
          created_at: string
          dedupe_key: string
          due_by: string | null
          estimated_minutes: number | null
          extras: Json
          id: string
          inspected_at: string | null
          last_evaluated_at: string
          notes: string | null
          paused_at: string | null
          priority: string
          property_id: string
          requires_inspection: boolean
          room_number: string
          rule_inputs: Json | null
          rules_fired: Json
          scheduled_at: string | null
          source_engine_run_id: string | null
          source_pms_reservation_id: string | null
          source_property_timezone: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          business_date: string
          cleaning_type: string
          completed_at?: string | null
          created_at?: string
          dedupe_key: string
          due_by?: string | null
          estimated_minutes?: number | null
          extras?: Json
          id?: string
          inspected_at?: string | null
          last_evaluated_at?: string
          notes?: string | null
          paused_at?: string | null
          priority?: string
          property_id: string
          requires_inspection?: boolean
          room_number: string
          rule_inputs?: Json | null
          rules_fired?: Json
          scheduled_at?: string | null
          source_engine_run_id?: string | null
          source_pms_reservation_id?: string | null
          source_property_timezone?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          business_date?: string
          cleaning_type?: string
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string
          due_by?: string | null
          estimated_minutes?: number | null
          extras?: Json
          id?: string
          inspected_at?: string | null
          last_evaluated_at?: string
          notes?: string | null
          paused_at?: string | null
          priority?: string
          property_id?: string
          requires_inspection?: boolean
          room_number?: string
          rule_inputs?: Json | null
          rules_fired?: Json
          scheduled_at?: string | null
          source_engine_run_id?: string | null
          source_pms_reservation_id?: string | null
          source_property_timezone?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_ack_campaigns: {
        Row: {
          created_at: string
          created_by_account: string | null
          id: string
          title: string | null
        }
        Insert: {
          created_at?: string
          created_by_account?: string | null
          id?: string
          title?: string | null
        }
        Update: {
          created_at?: string
          created_by_account?: string | null
          id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comms_ack_campaigns_created_by_account_fkey"
            columns: ["created_by_account"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_acknowledgements: {
        Row: {
          acknowledged_at: string
          id: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Insert: {
          acknowledged_at?: string
          id?: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Update: {
          acknowledged_at?: string
          id?: string
          message_id?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_acknowledgements_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_acknowledgements_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_conversations: {
        Row: {
          channel_key: string | null
          created_at: string
          created_by_staff_id: string | null
          dm_key: string | null
          id: string
          kind: string
          last_message_at: string | null
          property_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          channel_key?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          dm_key?: string | null
          id?: string
          kind: string
          last_message_at?: string | null
          property_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          channel_key?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          dm_key?: string | null
          id?: string
          kind?: string
          last_message_at?: string | null
          property_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_conversations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_log_entries: {
        Row: {
          author_staff_id: string | null
          body: string
          category: string | null
          created_at: string
          id: string
          property_id: string
          title: string
          updated_at: string
        }
        Insert: {
          author_staff_id?: string | null
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          property_id: string
          title: string
          updated_at?: string
        }
        Update: {
          author_staff_id?: string | null
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          property_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_log_entries_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_log_replies: {
        Row: {
          author_staff_id: string | null
          body: string
          created_at: string
          entry_id: string
          id: string
          property_id: string
        }
        Insert: {
          author_staff_id?: string | null
          body: string
          created_at?: string
          entry_id: string
          id?: string
          property_id: string
        }
        Update: {
          author_staff_id?: string | null
          body?: string
          created_at?: string
          entry_id?: string
          id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_log_replies_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "comms_log_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_log_replies_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_members: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          last_read_at: string | null
          property_id: string
          staff_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          last_read_at?: string | null
          property_id: string
          staff_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          last_read_at?: string | null
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_members_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "comms_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_members_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_message_translations: {
        Row: {
          created_at: string
          id: string
          lang: string
          message_id: string
          translated_body: string
        }
        Insert: {
          created_at?: string
          id?: string
          lang: string
          message_id: string
          translated_body: string
        }
        Update: {
          created_at?: string
          id?: string
          lang?: string
          message_id?: string
          translated_body?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_message_translations_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_messages: {
        Row: {
          ack_campaign_id: string | null
          attachment_kind: string | null
          attachment_path: string | null
          body: string
          conversation_id: string
          created_at: string
          handoff_outstanding: string | null
          handoff_shift: string | null
          id: string
          meta: Json
          msg_type: string
          parent_message_id: string | null
          pinned_at: string | null
          pinned_by_staff_id: string | null
          property_id: string
          requires_ack: boolean
          sender_kind: string
          sender_staff_id: string | null
          source_lang: string | null
          voice_duration_ms: number | null
        }
        Insert: {
          ack_campaign_id?: string | null
          attachment_kind?: string | null
          attachment_path?: string | null
          body?: string
          conversation_id: string
          created_at?: string
          handoff_outstanding?: string | null
          handoff_shift?: string | null
          id?: string
          meta?: Json
          msg_type?: string
          parent_message_id?: string | null
          pinned_at?: string | null
          pinned_by_staff_id?: string | null
          property_id: string
          requires_ack?: boolean
          sender_kind?: string
          sender_staff_id?: string | null
          source_lang?: string | null
          voice_duration_ms?: number | null
        }
        Update: {
          ack_campaign_id?: string | null
          attachment_kind?: string | null
          attachment_path?: string | null
          body?: string
          conversation_id?: string
          created_at?: string
          handoff_outstanding?: string | null
          handoff_shift?: string | null
          id?: string
          meta?: Json
          msg_type?: string
          parent_message_id?: string | null
          pinned_at?: string | null
          pinned_by_staff_id?: string | null
          property_id?: string
          requires_ack?: boolean
          sender_kind?: string
          sender_staff_id?: string | null
          source_lang?: string | null
          voice_duration_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "comms_messages_ack_campaign_id_fkey"
            columns: ["ack_campaign_id"]
            isOneToOne: false
            referencedRelation: "comms_ack_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "comms_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_messages_parent_message_id_fkey"
            columns: ["parent_message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_messages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_presence: {
        Row: {
          last_seen_at: string
          property_id: string
          staff_id: string
        }
        Insert: {
          last_seen_at?: string
          property_id: string
          staff_id: string
        }
        Update: {
          last_seen_at?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_presence_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_reactions: {
        Row: {
          created_at: string
          id: string
          kind: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          message_id?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_reactions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_tasks: {
        Row: {
          assigned_department: string | null
          assigned_staff_id: string | null
          completed_at: string | null
          completed_by_staff_id: string | null
          created_at: string
          created_by_staff_id: string | null
          due_at: string | null
          id: string
          notes: string | null
          priority: string
          property_id: string
          recurring_instance_date: string | null
          recurring_template_id: string | null
          source_message_id: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assigned_department?: string | null
          assigned_staff_id?: string | null
          completed_at?: string | null
          completed_by_staff_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          property_id: string
          recurring_instance_date?: string | null
          recurring_template_id?: string | null
          source_message_id?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assigned_department?: string | null
          assigned_staff_id?: string | null
          completed_at?: string | null
          completed_by_staff_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          property_id?: string
          recurring_instance_date?: string | null
          recurring_template_id?: string | null
          source_message_id?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_tasks_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_translation_cache: {
        Row: {
          created_at: string
          id: string
          source_hash: string
          source_text: string
          target_lang: string
          translated_text: string
        }
        Insert: {
          created_at?: string
          id?: string
          source_hash: string
          source_text: string
          target_lang: string
          translated_text: string
        }
        Update: {
          created_at?: string
          id?: string
          source_hash?: string
          source_text?: string
          target_lang?: string
          translated_text?: string
        }
        Relationships: []
      }
      company_access_mutation_requests: {
        Row: {
          actor_account_id: string
          created_at: string
          id: string
          idempotency_key: string
          membership_id: string
          organization_id: string
          request_fingerprint: string
          response: Json
        }
        Insert: {
          actor_account_id: string
          created_at?: string
          id?: string
          idempotency_key: string
          membership_id: string
          organization_id: string
          request_fingerprint: string
          response: Json
        }
        Update: {
          actor_account_id?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          membership_id?: string
          organization_id?: string
          request_fingerprint?: string
          response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "company_access_mutation_requests_actor_account_id_fkey"
            columns: ["actor_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_access_mutation_requests_membership_scope_fkey"
            columns: ["membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "company_access_mutation_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      company_access_settings: {
        Row: {
          organization_id: string
          setting_key: string
          setting_value: string
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          organization_id: string
          setting_key: string
          setting_value: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          organization_id?: string
          setting_key?: string
          setting_value?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "company_access_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_access_settings_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      company_authority_rules: {
        Row: {
          action_kind: string
          approver_role: string
          created_at: string
          created_by_account_id: string | null
          id: string
          is_active: boolean
          organization_id: string
          source_fact_id: string
          threshold_cents: number
          threshold_inclusive: boolean
          updated_at: string
        }
        Insert: {
          action_kind: string
          approver_role: string
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          is_active?: boolean
          organization_id: string
          source_fact_id: string
          threshold_cents: number
          threshold_inclusive?: boolean
          updated_at?: string
        }
        Update: {
          action_kind?: string
          approver_role?: string
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          is_active?: boolean
          organization_id?: string
          source_fact_id?: string
          threshold_cents?: number
          threshold_inclusive?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_authority_rules_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_authority_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_authority_rules_source_fact_id_fkey"
            columns: ["source_fact_id"]
            isOneToOne: false
            referencedRelation: "company_knowledge"
            referencedColumns: ["id"]
          },
        ]
      }
      company_finding_verdict_events: {
        Row: {
          account_authorization_version: number
          action: string
          actor_account_id: string
          affected_property_ids: string[]
          authorization_hash: string
          authorization_receipt_id: string
          committed_at: string
          detector_id: string
          finding_id: string
          from_status: string
          from_verdict_revision: number
          id: string
          organization_access_epoch: number
          organization_id: string
          receipt_expires_at: string
          receipt_resolved_at: string
          required_capabilities: string[]
          required_sections: string[]
          resolver_version: string
          scope_hash: string
          semantic_family: string | null
          to_status: string
          to_verdict_revision: number
        }
        Insert: {
          account_authorization_version: number
          action: string
          actor_account_id: string
          affected_property_ids: string[]
          authorization_hash: string
          authorization_receipt_id: string
          committed_at?: string
          detector_id: string
          finding_id: string
          from_status: string
          from_verdict_revision: number
          id?: string
          organization_access_epoch: number
          organization_id: string
          receipt_expires_at: string
          receipt_resolved_at: string
          required_capabilities: string[]
          required_sections: string[]
          resolver_version: string
          scope_hash: string
          semantic_family?: string | null
          to_status: string
          to_verdict_revision: number
        }
        Update: {
          account_authorization_version?: number
          action?: string
          actor_account_id?: string
          affected_property_ids?: string[]
          authorization_hash?: string
          authorization_receipt_id?: string
          committed_at?: string
          detector_id?: string
          finding_id?: string
          from_status?: string
          from_verdict_revision?: number
          id?: string
          organization_access_epoch?: number
          organization_id?: string
          receipt_expires_at?: string
          receipt_resolved_at?: string
          required_capabilities?: string[]
          required_sections?: string[]
          resolver_version?: string
          scope_hash?: string
          semantic_family?: string | null
          to_status?: string
          to_verdict_revision?: number
        }
        Relationships: []
      }
      company_finding_verdict_transaction_markers: {
        Row: {
          actor_account_id: string
          authorization_receipt_id: string
          finding_id: string
          transaction_id: unknown
        }
        Insert: {
          actor_account_id: string
          authorization_receipt_id: string
          finding_id: string
          transaction_id: unknown
        }
        Update: {
          actor_account_id?: string
          authorization_receipt_id?: string
          finding_id?: string
          transaction_id?: unknown
        }
        Relationships: []
      }
      company_findings: {
        Row: {
          affected_property_ids: string[]
          as_of: string | null
          classified_scope: string | null
          created_at: string
          dedupe_key: string
          detector_id: string
          disposition: string
          escalated_at: string | null
          evidence: Json
          first_seen_at: string
          id: string
          last_seen_at: string
          latest_pattern_candidate_id: string | null
          latest_pattern_effective_at: string | null
          latest_pattern_order_key: string | null
          latest_pattern_run_id: string | null
          magnitude: number
          occurrence_count: number
          organization_id: string
          pattern_check_version: string | null
          pattern_cohort_policy_version: string | null
          pattern_dedupe_policy_version: string | null
          pattern_engine_version: string | null
          pattern_normalization_policy_version: string | null
          pattern_schema_version: number | null
          pattern_scope_policy_version: string | null
          price_basis: string | null
          price_currency: string
          price_high_cents: number | null
          price_low_cents: number | null
          quality_metadata: Json
          receipt_query_id: string
          resolved_at: string | null
          root_key: string | null
          routing_metadata: Json
          semantic_family: string | null
          severity: string
          silenced_at_magnitude: number | null
          status: string
          status_changed_at: string
          status_changed_by: string | null
          summary: string
          updated_at: string
          verdict_revision: number
          weakest_input_age_days: number | null
        }
        Insert: {
          affected_property_ids?: string[]
          as_of?: string | null
          classified_scope?: string | null
          created_at?: string
          dedupe_key: string
          detector_id: string
          disposition?: string
          escalated_at?: string | null
          evidence?: Json
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          latest_pattern_candidate_id?: string | null
          latest_pattern_effective_at?: string | null
          latest_pattern_order_key?: string | null
          latest_pattern_run_id?: string | null
          magnitude?: number
          occurrence_count?: number
          organization_id: string
          pattern_check_version?: string | null
          pattern_cohort_policy_version?: string | null
          pattern_dedupe_policy_version?: string | null
          pattern_engine_version?: string | null
          pattern_normalization_policy_version?: string | null
          pattern_schema_version?: number | null
          pattern_scope_policy_version?: string | null
          price_basis?: string | null
          price_currency?: string
          price_high_cents?: number | null
          price_low_cents?: number | null
          quality_metadata?: Json
          receipt_query_id: string
          resolved_at?: string | null
          root_key?: string | null
          routing_metadata?: Json
          semantic_family?: string | null
          severity: string
          silenced_at_magnitude?: number | null
          status?: string
          status_changed_at?: string
          status_changed_by?: string | null
          summary: string
          updated_at?: string
          verdict_revision?: number
          weakest_input_age_days?: number | null
        }
        Update: {
          affected_property_ids?: string[]
          as_of?: string | null
          classified_scope?: string | null
          created_at?: string
          dedupe_key?: string
          detector_id?: string
          disposition?: string
          escalated_at?: string | null
          evidence?: Json
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          latest_pattern_candidate_id?: string | null
          latest_pattern_effective_at?: string | null
          latest_pattern_order_key?: string | null
          latest_pattern_run_id?: string | null
          magnitude?: number
          occurrence_count?: number
          organization_id?: string
          pattern_check_version?: string | null
          pattern_cohort_policy_version?: string | null
          pattern_dedupe_policy_version?: string | null
          pattern_engine_version?: string | null
          pattern_normalization_policy_version?: string | null
          pattern_schema_version?: number | null
          pattern_scope_policy_version?: string | null
          price_basis?: string | null
          price_currency?: string
          price_high_cents?: number | null
          price_low_cents?: number | null
          quality_metadata?: Json
          receipt_query_id?: string
          resolved_at?: string | null
          root_key?: string | null
          routing_metadata?: Json
          semantic_family?: string | null
          severity?: string
          silenced_at_magnitude?: number | null
          status?: string
          status_changed_at?: string
          status_changed_by?: string | null
          summary?: string
          updated_at?: string
          verdict_revision?: number
          weakest_input_age_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "company_findings_latest_pattern_candidate_fkey"
            columns: [
              "organization_id",
              "latest_pattern_candidate_id",
              "latest_pattern_run_id",
            ]
            isOneToOne: false
            referencedRelation: "management_pattern_candidates"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "company_findings_latest_pattern_run_fkey"
            columns: ["organization_id", "latest_pattern_run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "company_findings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_findings_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      company_knowledge: {
        Row: {
          category: string
          content: string
          created_at: string
          created_by_account_id: string | null
          created_by_name: string | null
          created_by_role: string | null
          current_revision: number
          id: string
          is_active: boolean
          organization_id: string
          policy_key: string | null
          policy_value: string | null
          review_state: string
          source: string
          topic: string
          updated_at: string
        }
        Insert: {
          category?: string
          content: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_by_role?: string | null
          current_revision?: number
          id?: string
          is_active?: boolean
          organization_id: string
          policy_key?: string | null
          policy_value?: string | null
          review_state?: string
          source?: string
          topic: string
          updated_at?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_by_role?: string | null
          current_revision?: number
          id?: string
          is_active?: boolean
          organization_id?: string
          policy_key?: string | null
          policy_value?: string | null
          review_state?: string
          source?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_knowledge_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_knowledge_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      company_knowledge_revision_context: {
        Row: {
          action: string
          actor_account_id: string | null
          actor_kind: string
          allow_revision_bump: boolean
          backend_pid: number
          fact_id: string
          operation_id: string
          request_id: string | null
          source: string
          suppress_automatic_revision: boolean
        }
        Insert: {
          action: string
          actor_account_id?: string | null
          actor_kind: string
          allow_revision_bump?: boolean
          backend_pid: number
          fact_id: string
          operation_id: string
          request_id?: string | null
          source: string
          suppress_automatic_revision?: boolean
        }
        Update: {
          action?: string
          actor_account_id?: string | null
          actor_kind?: string
          allow_revision_bump?: boolean
          backend_pid?: number
          fact_id?: string
          operation_id?: string
          request_id?: string | null
          source?: string
          suppress_automatic_revision?: boolean
        }
        Relationships: []
      }
      company_knowledge_revision_heads: {
        Row: {
          last_organization_revision: number
          last_revision_hash: string | null
          organization_id: string
          updated_at: string
        }
        Insert: {
          last_organization_revision?: number
          last_revision_hash?: string | null
          organization_id: string
          updated_at?: string
        }
        Update: {
          last_organization_revision?: number
          last_revision_hash?: string | null
          organization_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      company_knowledge_revision_ledger_state: {
        Row: {
          enforced_at: string | null
          rollout_mode: string
          schema_version: string
          singleton: boolean
        }
        Insert: {
          enforced_at?: string | null
          rollout_mode: string
          schema_version: string
          singleton?: boolean
        }
        Update: {
          enforced_at?: string | null
          rollout_mode?: string
          schema_version?: string
          singleton?: boolean
        }
        Relationships: []
      }
      company_knowledge_revisions: {
        Row: {
          action: string
          actor_account_id: string | null
          actor_kind: string
          after_snapshot: Json | null
          after_snapshot_hash: string | null
          before_snapshot: Json | null
          before_snapshot_hash: string | null
          fact_id: string
          fact_revision: number
          id: string
          merge_role: string | null
          occurred_at: string
          operation_id: string
          organization_id: string
          organization_revision: number
          previous_revision_hash: string | null
          related_fact_id: string | null
          request_id: string | null
          revision_hash: string
          source: string
        }
        Insert: {
          action: string
          actor_account_id?: string | null
          actor_kind: string
          after_snapshot?: Json | null
          after_snapshot_hash?: string | null
          before_snapshot?: Json | null
          before_snapshot_hash?: string | null
          fact_id: string
          fact_revision: number
          id?: string
          merge_role?: string | null
          occurred_at: string
          operation_id: string
          organization_id: string
          organization_revision: number
          previous_revision_hash?: string | null
          related_fact_id?: string | null
          request_id?: string | null
          revision_hash: string
          source: string
        }
        Update: {
          action?: string
          actor_account_id?: string | null
          actor_kind?: string
          after_snapshot?: Json | null
          after_snapshot_hash?: string | null
          before_snapshot?: Json | null
          before_snapshot_hash?: string | null
          fact_id?: string
          fact_revision?: number
          id?: string
          merge_role?: string | null
          occurred_at?: string
          operation_id?: string
          organization_id?: string
          organization_revision?: number
          previous_revision_hash?: string | null
          related_fact_id?: string | null
          request_id?: string | null
          revision_hash?: string
          source?: string
        }
        Relationships: []
      }
      company_structure_mutation_requests: {
        Row: {
          actor_account_id: string
          created_at: string
          id: string
          idempotency_key: string
          organization_id: string
          property_id: string
          request_fingerprint: string
          response: Json
        }
        Insert: {
          actor_account_id: string
          created_at?: string
          id?: string
          idempotency_key: string
          organization_id: string
          property_id: string
          request_fingerprint: string
          response: Json
        }
        Update: {
          actor_account_id?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          organization_id?: string
          property_id?: string
          request_fingerprint?: string
          response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "company_structure_mutation_requests_actor_account_id_fkey"
            columns: ["actor_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_structure_mutation_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_structure_mutation_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      complaints: {
        Row: {
          assigned_dept: string | null
          assigned_name: string | null
          assigned_to: string | null
          callback_at: string | null
          callback_done: boolean
          callback_notes: string | null
          callback_nudged_at: string | null
          category: string
          created_at: string
          created_by: string | null
          created_by_name: string | null
          description: string
          escalation_nudged_at: string | null
          guest_contact: string | null
          guest_name: string | null
          id: string
          linked_work_order_id: string | null
          property_id: string
          resolution_notes: string | null
          resolved_at: string | null
          room_number: string | null
          severity: string
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          assigned_dept?: string | null
          assigned_name?: string | null
          assigned_to?: string | null
          callback_at?: string | null
          callback_done?: boolean
          callback_notes?: string | null
          callback_nudged_at?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          description: string
          escalation_nudged_at?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          id?: string
          linked_work_order_id?: string | null
          property_id: string
          resolution_notes?: string | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_dept?: string | null
          assigned_name?: string | null
          assigned_to?: string | null
          callback_at?: string | null
          callback_done?: boolean
          callback_notes?: string | null
          callback_nudged_at?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          description?: string
          escalation_nudged_at?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          id?: string
          linked_work_order_id?: string | null
          property_id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "complaints_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_linked_work_order_id_fkey"
            columns: ["linked_work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      component_rooms: {
        Row: {
          child_room_numbers: Json
          created_at: string
          id: string
          label: string | null
          parent_room_number: string
          property_id: string
          updated_at: string
        }
        Insert: {
          child_room_numbers?: Json
          created_at?: string
          id?: string
          label?: string | null
          parent_room_number: string
          property_id: string
          updated_at?: string
        }
        Update: {
          child_room_numbers?: Json
          created_at?: string
          id?: string
          label?: string | null
          parent_room_number?: string
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "component_rooms_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_heartbeats: {
        Row: {
          cron_name: string
          last_request_id: string | null
          last_success_at: string
          notes: Json
          updated_at: string
        }
        Insert: {
          cron_name: string
          last_request_id?: string | null
          last_success_at?: string
          notes?: Json
          updated_at?: string
        }
        Update: {
          cron_name?: string
          last_request_id?: string | null
          last_success_at?: string
          notes?: Json
          updated_at?: string
        }
        Relationships: []
      }
      daily_logs: {
        Row: {
          actual_staff: number | null
          adr_cents: number | null
          arrivals: number | null
          avg_turnaround_minutes: number | null
          cancellations: number | null
          channel_mix: Json | null
          channel_source: string | null
          checkouts: number | null
          complaints_count: number | null
          completion_time: string | null
          comps_cents: number | null
          context: Json | null
          created_at: string
          date: string
          day_of_week: number | null
          departures: number | null
          discounts_cents: number | null
          early_checkins: number | null
          extended_stays: number | null
          flow_source: string | null
          fnb_revenue_cents: number | null
          hk_source: string | null
          hourly_wage: number | null
          id: string
          inspections_count: number | null
          inspections_passed: number | null
          inventory_consumed_cents: number | null
          inventory_spend_cents: number | null
          inventory_units_consumed: number | null
          labor_cost: number | null
          labor_cost_per_occupied_room_cents: number | null
          labor_hours: number | null
          labor_saved: number | null
          labor_source: string | null
          laundry_loads: Json | null
          laundry_minutes: number | null
          minutes_per_occupied_room: number | null
          no_shows: number | null
          occupancy_pct: number | null
          occupancy_source: string | null
          occupied: number | null
          other_revenue_cents: number | null
          property_id: string
          public_area_minutes: number | null
          public_areas_due_today: string[] | null
          recommended_staff: number | null
          refunds_cents: number | null
          revenue_source: string | null
          review_avg_score: number | null
          reviews_count: number | null
          revpar_cents: number | null
          room_minutes: number | null
          rooms_available: number | null
          rooms_completed: number | null
          rooms_ooo: number | null
          rooms_revenue_cents: number | null
          rooms_sold: number | null
          seal_version: number
          sealed_at: string | null
          source_completeness: Json | null
          start_time: string | null
          stayovers: number | null
          taxes_cents: number | null
          total_minutes: number | null
          total_revenue_cents: number | null
          two_bed_checkouts: number | null
          updated_at: string
          vips: number | null
          walk_ins: number | null
          work_orders_closed: number | null
          work_orders_open_at_eod: number | null
          work_orders_opened: number | null
        }
        Insert: {
          actual_staff?: number | null
          adr_cents?: number | null
          arrivals?: number | null
          avg_turnaround_minutes?: number | null
          cancellations?: number | null
          channel_mix?: Json | null
          channel_source?: string | null
          checkouts?: number | null
          complaints_count?: number | null
          completion_time?: string | null
          comps_cents?: number | null
          context?: Json | null
          created_at?: string
          date: string
          day_of_week?: number | null
          departures?: number | null
          discounts_cents?: number | null
          early_checkins?: number | null
          extended_stays?: number | null
          flow_source?: string | null
          fnb_revenue_cents?: number | null
          hk_source?: string | null
          hourly_wage?: number | null
          id?: string
          inspections_count?: number | null
          inspections_passed?: number | null
          inventory_consumed_cents?: number | null
          inventory_spend_cents?: number | null
          inventory_units_consumed?: number | null
          labor_cost?: number | null
          labor_cost_per_occupied_room_cents?: number | null
          labor_hours?: number | null
          labor_saved?: number | null
          labor_source?: string | null
          laundry_loads?: Json | null
          laundry_minutes?: number | null
          minutes_per_occupied_room?: number | null
          no_shows?: number | null
          occupancy_pct?: number | null
          occupancy_source?: string | null
          occupied?: number | null
          other_revenue_cents?: number | null
          property_id: string
          public_area_minutes?: number | null
          public_areas_due_today?: string[] | null
          recommended_staff?: number | null
          refunds_cents?: number | null
          revenue_source?: string | null
          review_avg_score?: number | null
          reviews_count?: number | null
          revpar_cents?: number | null
          room_minutes?: number | null
          rooms_available?: number | null
          rooms_completed?: number | null
          rooms_ooo?: number | null
          rooms_revenue_cents?: number | null
          rooms_sold?: number | null
          seal_version?: number
          sealed_at?: string | null
          source_completeness?: Json | null
          start_time?: string | null
          stayovers?: number | null
          taxes_cents?: number | null
          total_minutes?: number | null
          total_revenue_cents?: number | null
          two_bed_checkouts?: number | null
          updated_at?: string
          vips?: number | null
          walk_ins?: number | null
          work_orders_closed?: number | null
          work_orders_open_at_eod?: number | null
          work_orders_opened?: number | null
        }
        Update: {
          actual_staff?: number | null
          adr_cents?: number | null
          arrivals?: number | null
          avg_turnaround_minutes?: number | null
          cancellations?: number | null
          channel_mix?: Json | null
          channel_source?: string | null
          checkouts?: number | null
          complaints_count?: number | null
          completion_time?: string | null
          comps_cents?: number | null
          context?: Json | null
          created_at?: string
          date?: string
          day_of_week?: number | null
          departures?: number | null
          discounts_cents?: number | null
          early_checkins?: number | null
          extended_stays?: number | null
          flow_source?: string | null
          fnb_revenue_cents?: number | null
          hk_source?: string | null
          hourly_wage?: number | null
          id?: string
          inspections_count?: number | null
          inspections_passed?: number | null
          inventory_consumed_cents?: number | null
          inventory_spend_cents?: number | null
          inventory_units_consumed?: number | null
          labor_cost?: number | null
          labor_cost_per_occupied_room_cents?: number | null
          labor_hours?: number | null
          labor_saved?: number | null
          labor_source?: string | null
          laundry_loads?: Json | null
          laundry_minutes?: number | null
          minutes_per_occupied_room?: number | null
          no_shows?: number | null
          occupancy_pct?: number | null
          occupancy_source?: string | null
          occupied?: number | null
          other_revenue_cents?: number | null
          property_id?: string
          public_area_minutes?: number | null
          public_areas_due_today?: string[] | null
          recommended_staff?: number | null
          refunds_cents?: number | null
          revenue_source?: string | null
          review_avg_score?: number | null
          reviews_count?: number | null
          revpar_cents?: number | null
          room_minutes?: number | null
          rooms_available?: number | null
          rooms_completed?: number | null
          rooms_ooo?: number | null
          rooms_revenue_cents?: number | null
          rooms_sold?: number | null
          seal_version?: number
          sealed_at?: string | null
          source_completeness?: Json | null
          start_time?: string | null
          stayovers?: number | null
          taxes_cents?: number | null
          total_minutes?: number | null
          total_revenue_cents?: number | null
          two_bed_checkouts?: number | null
          updated_at?: string
          vips?: number | null
          walk_ins?: number | null
          work_orders_closed?: number | null
          work_orders_open_at_eod?: number | null
          work_orders_opened?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_by_date: {
        Row: {
          arrivals: number | null
          arrivals_guests: number | null
          date: string
          departures: number | null
          departures_guests: number | null
          error_code: string | null
          error_message: string | null
          error_page: string | null
          errored_at: string | null
          in_house: number | null
          in_house_guests: number | null
          property_id: string
          pulled_at: string | null
        }
        Insert: {
          arrivals?: number | null
          arrivals_guests?: number | null
          date: string
          departures?: number | null
          departures_guests?: number | null
          error_code?: string | null
          error_message?: string | null
          error_page?: string | null
          errored_at?: string | null
          in_house?: number | null
          in_house_guests?: number | null
          property_id: string
          pulled_at?: string | null
        }
        Update: {
          arrivals?: number | null
          arrivals_guests?: number | null
          date?: string
          departures?: number | null
          departures_guests?: number | null
          error_code?: string | null
          error_message?: string | null
          error_page?: string | null
          errored_at?: string | null
          in_house?: number | null
          in_house_guests?: number | null
          property_id?: string
          pulled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_by_date_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      deep_clean_config: {
        Row: {
          frequency_days: number
          minutes_per_room: number
          property_id: string
          target_per_week: number
          updated_at: string
        }
        Insert: {
          frequency_days?: number
          minutes_per_room?: number
          property_id: string
          target_per_week?: number
          updated_at?: string
        }
        Update: {
          frequency_days?: number
          minutes_per_room?: number
          property_id?: string
          target_per_week?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deep_clean_config_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      deep_clean_records: {
        Row: {
          assigned_at: string | null
          cleaned_by: string | null
          cleaned_by_team: string[] | null
          completed_at: string | null
          id: string
          last_deep_clean: string | null
          notes: string | null
          property_id: string
          room_number: string
          status: string | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string | null
          cleaned_by?: string | null
          cleaned_by_team?: string[] | null
          completed_at?: string | null
          id?: string
          last_deep_clean?: string | null
          notes?: string | null
          property_id: string
          room_number: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string | null
          cleaned_by?: string | null
          cleaned_by_team?: string[] | null
          completed_at?: string | null
          id?: string
          last_deep_clean?: string | null
          notes?: string | null
          property_id?: string
          room_number?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deep_clean_records_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      demand_predictions: {
        Row: {
          date: string
          features_snapshot: Json | null
          id: string
          model_run_id: string
          predicted_at: string
          predicted_headcount_p50: number | null
          predicted_headcount_p80: number | null
          predicted_headcount_p95: number | null
          predicted_minutes_p10: number | null
          predicted_minutes_p25: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75: number | null
          predicted_minutes_p90: number | null
          predicted_minutes_p95: number | null
          property_id: string
        }
        Insert: {
          date: string
          features_snapshot?: Json | null
          id?: string
          model_run_id: string
          predicted_at?: string
          predicted_headcount_p50?: number | null
          predicted_headcount_p80?: number | null
          predicted_headcount_p95?: number | null
          predicted_minutes_p10?: number | null
          predicted_minutes_p25?: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          predicted_minutes_p95?: number | null
          property_id: string
        }
        Update: {
          date?: string
          features_snapshot?: Json | null
          id?: string
          model_run_id?: string
          predicted_at?: string
          predicted_headcount_p50?: number | null
          predicted_headcount_p80?: number | null
          predicted_headcount_p95?: number | null
          predicted_minutes_p10?: number | null
          predicted_minutes_p25?: number | null
          predicted_minutes_p50?: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          predicted_minutes_p95?: number | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "demand_predictions_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demand_predictions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      demand_priors: {
        Row: {
          cohort_key: string
          id: string
          n_hotels_contributing: number
          prior_minutes_per_room_per_day: number
          prior_strength: number
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_room_per_day: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_room_per_day?: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      department_budgets: {
        Row: {
          budget_cents: number
          created_at: string
          department: string
          month_start: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          budget_cents: number
          created_at?: string
          department: string
          month_start: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          budget_cents?: number
          created_at?: string
          department?: string
          month_start?: string
          notes?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_budgets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment: {
        Row: {
          category: string
          created_at: string
          created_by_account_id: string | null
          created_by_name: string | null
          created_from: string
          expected_lifetime_years: number | null
          id: string
          install_date: string | null
          last_pm_at: string | null
          location: string | null
          manufacturer: string | null
          model_number: string | null
          name: string
          notes: string | null
          pm_interval_days: number | null
          property_id: string
          purchase_cost: number | null
          replacement_cost: number | null
          serial_number: string | null
          status: string
          updated_at: string
          warranty_expires_at: string | null
          warranty_provider: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_from?: string
          expected_lifetime_years?: number | null
          id?: string
          install_date?: string | null
          last_pm_at?: string | null
          location?: string | null
          manufacturer?: string | null
          model_number?: string | null
          name: string
          notes?: string | null
          pm_interval_days?: number | null
          property_id: string
          purchase_cost?: number | null
          replacement_cost?: number | null
          serial_number?: string | null
          status?: string
          updated_at?: string
          warranty_expires_at?: string | null
          warranty_provider?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_from?: string
          expected_lifetime_years?: number | null
          id?: string
          install_date?: string | null
          last_pm_at?: string | null
          location?: string | null
          manufacturer?: string | null
          model_number?: string | null
          name?: string
          notes?: string | null
          pm_interval_days?: number | null
          property_id?: string
          purchase_cost?: number | null
          replacement_cost?: number | null
          serial_number?: string | null
          status?: string
          updated_at?: string
          warranty_expires_at?: string | null
          warranty_provider?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      error_logs: {
        Row: {
          context: Json | null
          id: string
          message: string | null
          property_id: string | null
          source: string | null
          stack: string | null
          ts: string
        }
        Insert: {
          context?: Json | null
          id?: string
          message?: string | null
          property_id?: string | null
          source?: string | null
          stack?: string | null
          ts?: string
        }
        Update: {
          context?: Json | null
          id?: string
          message?: string | null
          property_id?: string | null
          source?: string | null
          stack?: string | null
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "error_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount_cents: number
          category: string
          created_at: string
          description: string | null
          id: string
          incurred_on: string
          metadata: Json
          property_id: string | null
          source: string
          vendor: string | null
        }
        Insert: {
          amount_cents: number
          category: string
          created_at?: string
          description?: string | null
          id?: string
          incurred_on: string
          metadata?: Json
          property_id?: string | null
          source?: string
          vendor?: string | null
        }
        Update: {
          amount_cents?: number
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          incurred_on?: string
          metadata?: Json
          property_id?: string | null
          source?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_expenses: {
        Row: {
          amount_cents: number
          category: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          department: string
          expense_date: string
          id: string
          invoice_date: string | null
          invoice_number: string | null
          notes: string | null
          property_id: string
          source: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount_cents: number
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          department?: string
          expense_date: string
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          notes?: string | null
          property_id: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount_cents?: number
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          department?: string
          expense_date?: string
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          notes?: string | null
          property_id?: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "financial_expenses_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_actions: {
        Row: {
          action_kind: string
          changed_facts: Json | null
          created_at: string
          created_object_id: string | null
          created_object_table: string | null
          decided_at: string | null
          decided_by: string | null
          failure_reason: string | null
          finding_id: string
          id: string
          idempotency_key: string
          outcome_due_at: string | null
          outcome_facts: Json | null
          outcome_kind: string | null
          outcome_observed_at: string | null
          params: Json
          params_fingerprint: string
          property_id: string
          proposed_at: string
          receipt: Json | null
          state: string
          undo: Json | null
          undone_at: string | null
          undone_by: string | null
          updated_at: string
          verify: Json
        }
        Insert: {
          action_kind: string
          changed_facts?: Json | null
          created_at?: string
          created_object_id?: string | null
          created_object_table?: string | null
          decided_at?: string | null
          decided_by?: string | null
          failure_reason?: string | null
          finding_id: string
          id?: string
          idempotency_key: string
          outcome_due_at?: string | null
          outcome_facts?: Json | null
          outcome_kind?: string | null
          outcome_observed_at?: string | null
          params: Json
          params_fingerprint?: string
          property_id: string
          proposed_at?: string
          receipt?: Json | null
          state?: string
          undo?: Json | null
          undone_at?: string | null
          undone_by?: string | null
          updated_at?: string
          verify?: Json
        }
        Update: {
          action_kind?: string
          changed_facts?: Json | null
          created_at?: string
          created_object_id?: string | null
          created_object_table?: string | null
          decided_at?: string | null
          decided_by?: string | null
          failure_reason?: string | null
          finding_id?: string
          id?: string
          idempotency_key?: string
          outcome_due_at?: string | null
          outcome_facts?: Json | null
          outcome_kind?: string | null
          outcome_observed_at?: string | null
          params?: Json
          params_fingerprint?: string
          property_id?: string
          proposed_at?: string
          receipt?: Json | null
          state?: string
          undo?: Json | null
          undone_at?: string | null
          undone_by?: string | null
          updated_at?: string
          verify?: Json
        }
        Relationships: [
          {
            foreignKeyName: "finding_actions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finding_actions_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finding_actions_finding_same_property_fk"
            columns: ["property_id", "finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["property_id", "id"]
          },
          {
            foreignKeyName: "finding_actions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finding_actions_undone_by_fkey"
            columns: ["undone_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_detector_state: {
        Row: {
          baseline_acted: number
          baseline_at: string
          baseline_shown: number
          created_at: string
          detector_id: string
          dormant: boolean
          dormant_since: string | null
          id: string
          property_id: string
          rearmed_at: string | null
          steps_down: number
          transitions: Json
          updated_at: string
        }
        Insert: {
          baseline_acted?: number
          baseline_at?: string
          baseline_shown?: number
          created_at?: string
          detector_id: string
          dormant?: boolean
          dormant_since?: string | null
          id?: string
          property_id: string
          rearmed_at?: string | null
          steps_down?: number
          transitions?: Json
          updated_at?: string
        }
        Update: {
          baseline_acted?: number
          baseline_at?: string
          baseline_shown?: number
          created_at?: string
          detector_id?: string
          dormant?: boolean
          dormant_since?: string | null
          id?: string
          property_id?: string
          rearmed_at?: string | null
          steps_down?: number
          transitions?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_detector_state_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_runs: {
        Row: {
          created_at: string
          detectors_checked: number
          detectors_dormant: number
          detectors_failed: number
          detectors_registered: number
          detectors_skipped: number
          duration_ms: number | null
          errors: Json
          findings_escalated: number
          findings_expired: number
          findings_opened: number
          findings_suppressed: number
          findings_updated: number
          id: string
          judge_cost_usd: number
          judge_findings: number
          judge_guard_rejections: number
          judge_mode: string | null
          property_id: string
          run_at: string
          run_date: string
        }
        Insert: {
          created_at?: string
          detectors_checked?: number
          detectors_dormant?: number
          detectors_failed?: number
          detectors_registered?: number
          detectors_skipped?: number
          duration_ms?: number | null
          errors?: Json
          findings_escalated?: number
          findings_expired?: number
          findings_opened?: number
          findings_suppressed?: number
          findings_updated?: number
          id?: string
          judge_cost_usd?: number
          judge_findings?: number
          judge_guard_rejections?: number
          judge_mode?: string | null
          property_id: string
          run_at?: string
          run_date: string
        }
        Update: {
          created_at?: string
          detectors_checked?: number
          detectors_dormant?: number
          detectors_failed?: number
          detectors_registered?: number
          detectors_skipped?: number
          duration_ms?: number | null
          errors?: Json
          findings_escalated?: number
          findings_expired?: number
          findings_opened?: number
          findings_suppressed?: number
          findings_updated?: number
          id?: string
          judge_cost_usd?: number
          judge_findings?: number
          judge_guard_rejections?: number
          judge_mode?: string | null
          property_id?: string
          run_at?: string
          run_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_sweep_runs: {
        Row: {
          candidates_local: number
          candidates_promoted: number
          cost_usd: number
          created_at: string
          detail: Json
          hypotheses: number
          id: string
          irreproducible: number
          mode: string
          model: string | null
          property_id: string
          reproduced: number
          run_at: string
          run_date: string
          signatures: string[]
        }
        Insert: {
          candidates_local?: number
          candidates_promoted?: number
          cost_usd?: number
          created_at?: string
          detail?: Json
          hypotheses?: number
          id?: string
          irreproducible?: number
          mode: string
          model?: string | null
          property_id: string
          reproduced?: number
          run_at?: string
          run_date: string
          signatures?: string[]
        }
        Update: {
          candidates_local?: number
          candidates_promoted?: number
          cost_usd?: number
          created_at?: string
          detail?: Json
          hypotheses?: number
          id?: string
          irreproducible?: number
          mode?: string
          model?: string | null
          property_id?: string
          reproduced?: number
          run_at?: string
          run_date?: string
          signatures?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "finding_sweep_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      findings: {
        Row: {
          acted_count: number
          as_of: string | null
          created_at: string
          dedupe_key: string
          detector_id: string
          disposition: string
          escalated_at: string | null
          evidence: Json
          first_seen_at: string
          id: string
          ignored_count: number
          judged_at: string | null
          judged_disposition: string | null
          judged_guard_rejected: boolean
          judged_input_hash: string | null
          judged_model: string | null
          judged_rank: number | null
          judged_rationale: string | null
          judged_source: string | null
          judged_summary_en: string | null
          judged_summary_es: string | null
          last_seen_at: string
          last_shown_on: string | null
          magnitude: number
          occurrence_count: number
          price_basis: string | null
          price_currency: string
          price_high_cents: number | null
          price_low_cents: number | null
          property_id: string
          receipt_query_id: string
          resolved_at: string | null
          severity: string
          shown_count: number
          silenced_at_magnitude: number | null
          status: string
          status_changed_at: string
          status_changed_by: string | null
          summary: string
          updated_at: string
          weakest_input_age_days: number | null
        }
        Insert: {
          acted_count?: number
          as_of?: string | null
          created_at?: string
          dedupe_key: string
          detector_id: string
          disposition?: string
          escalated_at?: string | null
          evidence?: Json
          first_seen_at?: string
          id?: string
          ignored_count?: number
          judged_at?: string | null
          judged_disposition?: string | null
          judged_guard_rejected?: boolean
          judged_input_hash?: string | null
          judged_model?: string | null
          judged_rank?: number | null
          judged_rationale?: string | null
          judged_source?: string | null
          judged_summary_en?: string | null
          judged_summary_es?: string | null
          last_seen_at?: string
          last_shown_on?: string | null
          magnitude?: number
          occurrence_count?: number
          price_basis?: string | null
          price_currency?: string
          price_high_cents?: number | null
          price_low_cents?: number | null
          property_id: string
          receipt_query_id: string
          resolved_at?: string | null
          severity: string
          shown_count?: number
          silenced_at_magnitude?: number | null
          status?: string
          status_changed_at?: string
          status_changed_by?: string | null
          summary: string
          updated_at?: string
          weakest_input_age_days?: number | null
        }
        Update: {
          acted_count?: number
          as_of?: string | null
          created_at?: string
          dedupe_key?: string
          detector_id?: string
          disposition?: string
          escalated_at?: string | null
          evidence?: Json
          first_seen_at?: string
          id?: string
          ignored_count?: number
          judged_at?: string | null
          judged_disposition?: string | null
          judged_guard_rejected?: boolean
          judged_input_hash?: string | null
          judged_model?: string | null
          judged_rank?: number | null
          judged_rationale?: string | null
          judged_source?: string | null
          judged_summary_en?: string | null
          judged_summary_es?: string | null
          last_seen_at?: string
          last_shown_on?: string | null
          magnitude?: number
          occurrence_count?: number
          price_basis?: string | null
          price_currency?: string
          price_high_cents?: number | null
          price_low_cents?: number | null
          property_id?: string
          receipt_query_id?: string
          resolved_at?: string | null
          severity?: string
          shown_count?: number
          silenced_at_magnitude?: number | null
          status?: string
          status_changed_at?: string
          status_changed_by?: string | null
          summary?: string
          updated_at?: string
          weakest_input_age_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "findings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "findings_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      findings_ai_spend: {
        Row: {
          cost_usd: number
          created_at: string
          feature: string
          id: string
          model: string | null
          model_id: string | null
          property_id: string
          state: string
          tokens_in: number
          tokens_out: number
          updated_at: string
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          feature?: string
          id?: string
          model?: string | null
          model_id?: string | null
          property_id: string
          state?: string
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
        }
        Update: {
          cost_usd?: number
          created_at?: string
          feature?: string
          id?: string
          model?: string | null
          model_id?: string | null
          property_id?: string
          state?: string
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "findings_ai_spend_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      github_events: {
        Row: {
          branch: string | null
          event_type: string
          id: string
          metadata: Json
          ts: string
        }
        Insert: {
          branch?: string | null
          event_type: string
          id?: string
          metadata?: Json
          ts?: string
        }
        Update: {
          branch?: string | null
          event_type?: string
          id?: string
          metadata?: Json
          ts?: string
        }
        Relationships: []
      }
      guest_requests: {
        Row: {
          assigned_name: string | null
          assigned_to: string | null
          completed_at: string | null
          created_at: string
          id: string
          notes: string | null
          property_id: string
          room_number: string
          status: string
          type: string
        }
        Insert: {
          assigned_name?: string | null
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          property_id: string
          room_number: string
          status?: string
          type: string
        }
        Update: {
          assigned_name?: string | null
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          property_id?: string
          room_number?: string
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_requests_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_logs: {
        Row: {
          acknowledged: boolean
          acknowledged_at: string | null
          acknowledged_by: string | null
          author: string
          created_at: string
          id: string
          notes: string
          property_id: string
          shift_type: string
        }
        Insert: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          author: string
          created_at?: string
          id?: string
          notes: string
          property_id: string
          shift_type: string
        }
        Update: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          author?: string
          created_at?: string
          id?: string
          notes?: string
          property_id?: string
          shift_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      hk_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string
          assigned_by_user_id: string | null
          cleaning_task_id: string
          created_at: string
          housekeeper_id: string
          id: string
          is_active: boolean
          property_id: string
          queue_order: number
          reason: string | null
          score: number | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string
          assigned_by_user_id?: string | null
          cleaning_task_id: string
          created_at?: string
          housekeeper_id: string
          id?: string
          is_active?: boolean
          property_id: string
          queue_order?: number
          reason?: string | null
          score?: number | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string
          assigned_by_user_id?: string | null
          cleaning_task_id?: string
          created_at?: string
          housekeeper_id?: string
          id?: string
          is_active?: boolean
          property_id?: string
          queue_order?: number
          reason?: string | null
          score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hk_assignments_cleaning_task_id_fkey"
            columns: ["cleaning_task_id"]
            isOneToOne: false
            referencedRelation: "cleaning_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hk_assignments_housekeeper_id_fkey"
            columns: ["housekeeper_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hk_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      hk_clean_time_standards: {
        Row: {
          base_minutes: number
          cleaning_type: string
          created_at: string
          id: string
          property_id: string
          room_type: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          base_minutes: number
          cleaning_type: string
          created_at?: string
          id?: string
          property_id: string
          room_type?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          base_minutes?: number
          cleaning_type?: string
          created_at?: string
          id?: string
          property_id?: string
          room_type?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hk_clean_time_standards_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hk_clean_time_standards_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      hotel_join_codes: {
        Row: {
          code: string
          code_kind: string
          created_at: string
          created_by: string
          expires_at: string
          hotel_id: string
          id: string
          max_uses: number
          revoked_at: string | null
          role: string | null
          used_count: number
        }
        Insert: {
          code: string
          code_kind?: string
          created_at?: string
          created_by: string
          expires_at: string
          hotel_id: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          role?: string | null
          used_count?: number
        }
        Update: {
          code?: string
          code_kind?: string
          created_at?: string
          created_by?: string
          expires_at?: string
          hotel_id?: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          role?: string | null
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "hotel_join_codes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hotel_join_codes_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeper_audit_log: {
        Row: {
          business_date: string
          created_at: string
          event_type: string
          id: string
          payload: Json
          property_id: string
          room_id: string | null
          room_number: string | null
          staff_id: string
        }
        Insert: {
          business_date: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          property_id: string
          room_id?: string | null
          room_number?: string | null
          staff_id: string
        }
        Update: {
          business_date?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          property_id?: string
          room_id?: string | null
          room_number?: string | null
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeper_audit_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeper_dismissed_notices: {
        Row: {
          dismissed_at: string
          id: string
          notice_id: string
          property_id: string
          staff_id: string
        }
        Insert: {
          dismissed_at?: string
          id?: string
          notice_id: string
          property_id: string
          staff_id: string
        }
        Update: {
          dismissed_at?: string
          id?: string
          notice_id?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeper_dismissed_notices_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "housekeeping_notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "housekeeper_dismissed_notices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeping_notices: {
        Row: {
          body_en: string
          body_es: string | null
          body_ht: string | null
          body_tl: string | null
          body_vi: string | null
          created_at: string
          expires_at: string | null
          id: string
          pinned: boolean
          posted_at: string
          posted_by_account_id: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          body_en: string
          body_es?: string | null
          body_ht?: string | null
          body_tl?: string | null
          body_vi?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          posted_at?: string
          posted_by_account_id?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          body_en?: string
          body_es?: string | null
          body_ht?: string | null
          body_tl?: string | null
          body_vi?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          posted_at?: string
          posted_by_account_id?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeping_notices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_log: {
        Row: {
          created_at: string
          expires_at: string
          key: string
          property_id: string | null
          response: Json
          route: string
          status_code: number
        }
        Insert: {
          created_at?: string
          expires_at?: string
          key: string
          property_id?: string | null
          response: Json
          route: string
          status_code?: number
        }
        Update: {
          created_at?: string
          expires_at?: string
          key?: string
          property_id?: string | null
          response?: Json
          route?: string
          status_code?: number
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_checklist_items: {
        Row: {
          category: string
          checklist_id: string
          created_at: string
          id: string
          label: string
          label_es: string | null
          order_index: number
          requires_photo_on_fail: boolean
          severity_default: string
        }
        Insert: {
          category: string
          checklist_id: string
          created_at?: string
          id?: string
          label: string
          label_es?: string | null
          order_index?: number
          requires_photo_on_fail?: boolean
          severity_default?: string
        }
        Update: {
          category?: string
          checklist_id?: string
          created_at?: string
          id?: string
          label?: string
          label_es?: string | null
          order_index?: number
          requires_photo_on_fail?: boolean
          severity_default?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspection_checklist_items_checklist_id_fkey"
            columns: ["checklist_id"]
            isOneToOne: false
            referencedRelation: "inspection_checklists"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_checklists: {
        Row: {
          applies_to_cleaning_types: string[]
          applies_to_room_types: string[]
          created_at: string
          id: string
          is_active: boolean
          name: string
          property_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          applies_to_cleaning_types?: string[]
          applies_to_room_types?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          property_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          applies_to_cleaning_types?: string[]
          applies_to_room_types?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          property_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "inspection_checklists_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inspections: {
        Row: {
          checklist_id: string | null
          cleaning_task_id: string | null
          completed_at: string | null
          correction_notice_sent_at: string | null
          created_at: string
          escalated: boolean
          escalation_reason: string | null
          failed_items: Json
          housekeeper_staff_id: string | null
          id: string
          inspector_staff_id: string | null
          notes: string | null
          parent_inspection_id: string | null
          passed_items: Json
          property_id: string
          recheck_inspection_id: string | null
          result: string
          room_id: string | null
          room_number: string
          started_at: string
          updated_at: string
        }
        Insert: {
          checklist_id?: string | null
          cleaning_task_id?: string | null
          completed_at?: string | null
          correction_notice_sent_at?: string | null
          created_at?: string
          escalated?: boolean
          escalation_reason?: string | null
          failed_items?: Json
          housekeeper_staff_id?: string | null
          id?: string
          inspector_staff_id?: string | null
          notes?: string | null
          parent_inspection_id?: string | null
          passed_items?: Json
          property_id: string
          recheck_inspection_id?: string | null
          result?: string
          room_id?: string | null
          room_number: string
          started_at?: string
          updated_at?: string
        }
        Update: {
          checklist_id?: string | null
          cleaning_task_id?: string | null
          completed_at?: string | null
          correction_notice_sent_at?: string | null
          created_at?: string
          escalated?: boolean
          escalation_reason?: string | null
          failed_items?: Json
          housekeeper_staff_id?: string | null
          id?: string
          inspector_staff_id?: string | null
          notes?: string | null
          parent_inspection_id?: string | null
          passed_items?: Json
          property_id?: string
          recheck_inspection_id?: string | null
          result?: string
          room_id?: string | null
          room_number?: string
          started_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspections_checklist_id_fkey"
            columns: ["checklist_id"]
            isOneToOne: false
            referencedRelation: "inspection_checklists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_parent_inspection_id_fkey"
            columns: ["parent_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_recheck_inspection_id_fkey"
            columns: ["recheck_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          case_unit: string | null
          category: string
          created_at: string | null
          created_by: string | null
          current_stock: number
          custom_category_id: string | null
          delivery_baseline_last_ordered_at: string | null
          delivery_baseline_unit_cost: number | null
          delivery_baseline_vendor_name: string | null
          delivery_cache_active: boolean
          id: string
          last_alerted_at: string | null
          last_counted_at: string | null
          last_ordered_at: string | null
          name: string
          notes: string | null
          opening_adjustment_at: string | null
          opening_adjustment_quantity: number | null
          opening_adjustment_request_id: string | null
          opening_adjustment_unit_cost: number | null
          pack_size: number | null
          par_level: number
          property_id: string
          reorder_at: number | null
          reorder_lead_days: number | null
          set_aside: number
          unit: string
          unit_cost: number | null
          updated_at: string
          usage_per_checkout: number | null
          usage_per_stayover: number | null
          vendor_id: string | null
          vendor_name: string | null
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          case_unit?: string | null
          category: string
          created_at?: string | null
          created_by?: string | null
          current_stock?: number
          custom_category_id?: string | null
          delivery_baseline_last_ordered_at?: string | null
          delivery_baseline_unit_cost?: number | null
          delivery_baseline_vendor_name?: string | null
          delivery_cache_active?: boolean
          id?: string
          last_alerted_at?: string | null
          last_counted_at?: string | null
          last_ordered_at?: string | null
          name: string
          notes?: string | null
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number | null
          opening_adjustment_request_id?: string | null
          opening_adjustment_unit_cost?: number | null
          pack_size?: number | null
          par_level?: number
          property_id: string
          reorder_at?: number | null
          reorder_lead_days?: number | null
          set_aside?: number
          unit: string
          unit_cost?: number | null
          updated_at?: string
          usage_per_checkout?: number | null
          usage_per_stayover?: number | null
          vendor_id?: string | null
          vendor_name?: string | null
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          case_unit?: string | null
          category?: string
          created_at?: string | null
          created_by?: string | null
          current_stock?: number
          custom_category_id?: string | null
          delivery_baseline_last_ordered_at?: string | null
          delivery_baseline_unit_cost?: number | null
          delivery_baseline_vendor_name?: string | null
          delivery_cache_active?: boolean
          id?: string
          last_alerted_at?: string | null
          last_counted_at?: string | null
          last_ordered_at?: string | null
          name?: string
          notes?: string | null
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number | null
          opening_adjustment_request_id?: string | null
          opening_adjustment_unit_cost?: number | null
          pack_size?: number | null
          par_level?: number
          property_id?: string
          reorder_at?: number | null
          reorder_lead_days?: number | null
          set_aside?: number
          unit?: string
          unit_cost?: number | null
          updated_at?: string
          usage_per_checkout?: number | null
          usage_per_stayover?: number | null
          vendor_id?: string | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_custom_category_id_fkey"
            columns: ["custom_category_id"]
            isOneToOne: false
            referencedRelation: "inventory_custom_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_audit_events: {
        Row: {
          action: string
          actor_name: string | null
          actor_user_id: string | null
          after_state: Json | null
          before_state: Json | null
          created_at: string
          dedupe_key: string | null
          details: Json
          entity_id: string | null
          entity_key: string
          entity_type: string
          financial_details: Json
          id: string
          occurred_at: string
          property_id: string
          request_id: string | null
          sequence: number
          source_id: string
          source_table: string
          summary: Json
        }
        Insert: {
          action: string
          actor_name?: string | null
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          dedupe_key?: string | null
          details?: Json
          entity_id?: string | null
          entity_key: string
          entity_type: string
          financial_details?: Json
          id?: string
          occurred_at: string
          property_id: string
          request_id?: string | null
          sequence?: number
          source_id: string
          source_table: string
          summary?: Json
        }
        Update: {
          action?: string
          actor_name?: string | null
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          dedupe_key?: string | null
          details?: Json
          entity_id?: string | null
          entity_key?: string
          entity_type?: string
          financial_details?: Json
          id?: string
          occurred_at?: string
          property_id?: string
          request_id?: string | null
          sequence?: number
          source_id?: string
          source_table?: string
          summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "inventory_audit_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_budget_sections: {
        Row: {
          created_at: string
          id: string
          item_ids: string[]
          name: string
          property_id: string
          sort: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_ids?: string[]
          name: string
          property_id: string
          sort?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          item_ids?: string[]
          name?: string
          property_id?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_budget_sections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_budgets: {
        Row: {
          basis: string
          budget_cents: number
          category: string
          created_at: string
          month_start: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          basis?: string
          budget_cents: number
          category: string
          created_at?: string
          month_start: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          basis?: string
          budget_cents?: number
          category?: string
          created_at?: string
          month_start?: string
          notes?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_budgets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_counts: {
        Row: {
          activity_sequence: number
          count_session_id: string | null
          counted_at: string
          counted_by: string | null
          counted_stock: number
          created_at: string
          estimated_stock: number | null
          id: string
          item_id: string
          item_name: string
          notes: string | null
          property_id: string
          recorded_by_name: string | null
          recorded_by_user_id: string | null
          unit_cost: number | null
          variance: number | null
          variance_value: number | null
        }
        Insert: {
          activity_sequence?: number
          count_session_id?: string | null
          counted_at?: string
          counted_by?: string | null
          counted_stock: number
          created_at?: string
          estimated_stock?: number | null
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          property_id: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          unit_cost?: number | null
          variance?: number | null
          variance_value?: number | null
        }
        Update: {
          activity_sequence?: number
          count_session_id?: string | null
          counted_at?: string
          counted_by?: string | null
          counted_stock?: number
          created_at?: string
          estimated_stock?: number | null
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          property_id?: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          unit_cost?: number | null
          variance?: number | null
          variance_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_custom_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          property_id: string
          sort: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          property_id: string
          sort?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          property_id?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_custom_categories_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_delivery_corrections: {
        Row: {
          activity_sequence: number
          corrected_at: string
          corrected_by: string | null
          corrected_by_user_id: string | null
          corrected_item_id: string | null
          corrected_item_name: string | null
          corrected_quantity: number
          corrected_total_cost: number | null
          corrected_unit_cost: number | null
          correction_kind: string
          created_at: string
          id: string
          line_key: string
          original_order_id: string
          previous_item_id: string
          previous_item_name: string
          previous_quantity: number
          previous_total_cost: number | null
          previous_unit_cost: number | null
          prior_correction_id: string | null
          property_id: string
          reason: string
          request_id: string
          stock_effect: Json
        }
        Insert: {
          activity_sequence?: number
          corrected_at: string
          corrected_by?: string | null
          corrected_by_user_id?: string | null
          corrected_item_id?: string | null
          corrected_item_name?: string | null
          corrected_quantity: number
          corrected_total_cost?: number | null
          corrected_unit_cost?: number | null
          correction_kind: string
          created_at?: string
          id?: string
          line_key: string
          original_order_id: string
          previous_item_id: string
          previous_item_name: string
          previous_quantity: number
          previous_total_cost?: number | null
          previous_unit_cost?: number | null
          prior_correction_id?: string | null
          property_id: string
          reason: string
          request_id: string
          stock_effect?: Json
        }
        Update: {
          activity_sequence?: number
          corrected_at?: string
          corrected_by?: string | null
          corrected_by_user_id?: string | null
          corrected_item_id?: string | null
          corrected_item_name?: string | null
          corrected_quantity?: number
          corrected_total_cost?: number | null
          corrected_unit_cost?: number | null
          correction_kind?: string
          created_at?: string
          id?: string
          line_key?: string
          original_order_id?: string
          previous_item_id?: string
          previous_item_name?: string
          previous_quantity?: number
          previous_total_cost?: number | null
          previous_unit_cost?: number | null
          prior_correction_id?: string | null
          property_id?: string
          reason?: string
          request_id?: string
          stock_effect?: Json
        }
        Relationships: [
          {
            foreignKeyName: "inventory_delivery_correction_corrected_item_id_property_i_fkey"
            columns: ["corrected_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_corrected_item_id_property_i_fkey"
            columns: ["corrected_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_original_order_id_property_i_fkey"
            columns: ["original_order_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_orders"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_previous_item_id_property_id_fkey"
            columns: ["previous_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_previous_item_id_property_id_fkey"
            columns: ["previous_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_prior_correction_id_property_fkey"
            columns: ["prior_correction_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_corrections"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_corrections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_delivery_keys: {
        Row: {
          created_at: string
          delivery_key: string
          property_id: string
          request_id: string | null
        }
        Insert: {
          created_at?: string
          delivery_key: string
          property_id: string
          request_id?: string | null
        }
        Update: {
          created_at?: string
          delivery_key?: string
          property_id?: string
          request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_delivery_keys_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_delivery_reentries: {
        Row: {
          created_at: string
          delivery_key: string
          id: string
          prior_request_id: string | null
          property_id: string
          reentered_by_user_id: string | null
          replacement_request_id: string
        }
        Insert: {
          created_at?: string
          delivery_key: string
          id?: string
          prior_request_id?: string | null
          property_id: string
          reentered_by_user_id?: string | null
          replacement_request_id: string
        }
        Update: {
          created_at?: string
          delivery_key?: string
          id?: string
          prior_request_id?: string | null
          property_id?: string
          reentered_by_user_id?: string | null
          replacement_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_delivery_reentries_property_id_delivery_key_fkey"
            columns: ["property_id", "delivery_key"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_keys"
            referencedColumns: ["property_id", "delivery_key"]
          },
          {
            foreignKeyName: "inventory_delivery_reentries_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_delivery_reentries_property_id_replacement_reque_fkey"
            columns: ["property_id", "replacement_request_id"]
            isOneToOne: false
            referencedRelation: "inventory_write_receipts"
            referencedColumns: ["property_id", "request_id"]
          },
        ]
      }
      inventory_discards: {
        Row: {
          activity_sequence: number
          cost_value: number | null
          created_at: string
          discarded_at: string
          discarded_by: string | null
          expected_stock: number | null
          id: string
          item_id: string
          item_name: string
          notes: string | null
          property_id: string
          quantity: number
          reason: string
          recorded_by_user_id: string | null
          request_id: string | null
          stock_after: number | null
          stock_before: number | null
          unit_cost: number | null
        }
        Insert: {
          activity_sequence?: number
          cost_value?: number | null
          created_at?: string
          discarded_at?: string
          discarded_by?: string | null
          expected_stock?: number | null
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          property_id: string
          quantity: number
          reason: string
          recorded_by_user_id?: string | null
          request_id?: string | null
          stock_after?: number | null
          stock_before?: number | null
          unit_cost?: number | null
        }
        Update: {
          activity_sequence?: number
          cost_value?: number | null
          created_at?: string
          discarded_at?: string
          discarded_by?: string | null
          expected_stock?: number | null
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          property_id?: string
          quantity?: number
          reason?: string
          recorded_by_user_id?: string | null
          request_id?: string | null
          stock_after?: number | null
          stock_before?: number | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_discards_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_discards_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_discards_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_month_close_purchases: {
        Row: {
          budget_key: string
          budget_section_ids: string[]
          category: string
          close_id: string
          created_at: string
          custom_category_id: string | null
          custom_category_name: string | null
          item_id: string
          item_name: string
          multiple_budget_sections: boolean
          property_id: string
          quantity: number
          received_at: string
          source_order_id: string
          unit_cost_cents: number
          value_cents: number
          vendor_name: string | null
        }
        Insert: {
          budget_key: string
          budget_section_ids?: string[]
          category: string
          close_id: string
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          item_id: string
          item_name: string
          multiple_budget_sections?: boolean
          property_id: string
          quantity: number
          received_at: string
          source_order_id: string
          unit_cost_cents: number
          value_cents: number
          vendor_name?: string | null
        }
        Update: {
          budget_key?: string
          budget_section_ids?: string[]
          category?: string
          close_id?: string
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          item_id?: string
          item_name?: string
          multiple_budget_sections?: boolean
          property_id?: string
          quantity?: number
          received_at?: string
          source_order_id?: string
          unit_cost_cents?: number
          value_cents?: number
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_close_purchase_source_order_id_property_id_fkey"
            columns: ["source_order_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_orders"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_purchases_close_id_property_id_fkey"
            columns: ["close_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_closes"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_purchases_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_purchases_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
        ]
      }
      inventory_month_close_snapshot_items: {
        Row: {
          actual_usage_cents: number | null
          archived_at: string | null
          budget_key: string
          budget_section_ids: string[]
          category: string
          counted_at: string | null
          created_at: string
          custom_category_id: string | null
          custom_category_name: string | null
          inventory_count_id: string | null
          inventory_delivery_correction_id: string | null
          inventory_discard_id: string | null
          item_id: string
          item_name: string
          multiple_budget_sections: boolean
          opening_adjustment_at: string | null
          opening_adjustment_quantity: number
          opening_adjustment_unit_cost_cents: number | null
          opening_adjustment_value_cents: number
          physical_unit_cost_cents: number | null
          property_id: string
          purchase_quantity: number | null
          purchase_value_cents: number | null
          quantity: number
          set_aside: number
          snapshot_id: string
          unit_cost_cents: number | null
          valuation_method: string
          value_cents: number | null
        }
        Insert: {
          actual_usage_cents?: number | null
          archived_at?: string | null
          budget_key: string
          budget_section_ids?: string[]
          category: string
          counted_at?: string | null
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          inventory_count_id?: string | null
          inventory_delivery_correction_id?: string | null
          inventory_discard_id?: string | null
          item_id: string
          item_name: string
          multiple_budget_sections?: boolean
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number
          opening_adjustment_unit_cost_cents?: number | null
          opening_adjustment_value_cents?: number
          physical_unit_cost_cents?: number | null
          property_id: string
          purchase_quantity?: number | null
          purchase_value_cents?: number | null
          quantity: number
          set_aside?: number
          snapshot_id: string
          unit_cost_cents?: number | null
          valuation_method: string
          value_cents?: number | null
        }
        Update: {
          actual_usage_cents?: number | null
          archived_at?: string | null
          budget_key?: string
          budget_section_ids?: string[]
          category?: string
          counted_at?: string | null
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          inventory_count_id?: string | null
          inventory_delivery_correction_id?: string | null
          inventory_discard_id?: string | null
          item_id?: string
          item_name?: string
          multiple_budget_sections?: boolean
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number
          opening_adjustment_unit_cost_cents?: number | null
          opening_adjustment_value_cents?: number
          physical_unit_cost_cents?: number | null
          property_id?: string
          purchase_quantity?: number | null
          purchase_value_cents?: number | null
          quantity?: number
          set_aside?: number
          snapshot_id?: string
          unit_cost_cents?: number | null
          valuation_method?: string
          value_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_close_snapsho_inventory_count_id_property__fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapsho_inventory_count_id_property__fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_observed_rate_v"
            referencedColumns: ["newer_count_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_ite_snapshot_id_property_id_fkey"
            columns: ["snapshot_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_close_snapshots"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_correction_property_fkey"
            columns: ["inventory_delivery_correction_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_corrections"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_discard_property_fkey"
            columns: ["inventory_discard_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_discards"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
        ]
      }
      inventory_month_close_snapshots: {
        Row: {
          captured_at: string
          created_at: string
          id: string
          kind: string
          property_id: string
        }
        Insert: {
          captured_at: string
          created_at?: string
          id?: string
          kind: string
          property_id: string
        }
        Update: {
          captured_at?: string
          created_at?: string
          id?: string
          kind?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_close_snapshots_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_month_closes: {
        Row: {
          activity_start_at: string
          actual_usage_cents: number | null
          allocation_mode: string | null
          baseline_at: string
          beginning_value_cents: number | null
          budget_comparison_available: boolean
          by_budget_key: Json | null
          by_category: Json | null
          by_item: Json | null
          close_request_id: string | null
          closed_at: string | null
          closed_by: string | null
          closed_by_name: string | null
          confirmed_purchase_cents: number | null
          count_window_start_at: string
          created_at: string
          end_at: string
          ending_snapshot_id: string | null
          ending_value_cents: number | null
          grace_end_at: string
          id: string
          is_partial: boolean
          known_logged_purchase_cents: number
          logged_delivery_count: number
          logged_purchase_cents: number | null
          manual_purchase_cents: number | null
          month_start: string
          month_start_at: string
          notes: string | null
          opened_by: string | null
          opened_by_name: string | null
          opening_adjustment_cents: number
          opening_snapshot_id: string
          property_id: string
          purchase_source: string | null
          quality_flags: Json
          start_request_id: string | null
          status: string
          timezone: string
          uncosted_delivery_count: number
          updated_at: string
          usage_budget_by_key: Json | null
          usage_budget_mode: string | null
          usage_budget_total_cents: number | null
        }
        Insert: {
          activity_start_at: string
          actual_usage_cents?: number | null
          allocation_mode?: string | null
          baseline_at: string
          beginning_value_cents?: number | null
          budget_comparison_available: boolean
          by_budget_key?: Json | null
          by_category?: Json | null
          by_item?: Json | null
          close_request_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_by_name?: string | null
          confirmed_purchase_cents?: number | null
          count_window_start_at: string
          created_at?: string
          end_at: string
          ending_snapshot_id?: string | null
          ending_value_cents?: number | null
          grace_end_at: string
          id?: string
          is_partial: boolean
          known_logged_purchase_cents?: number
          logged_delivery_count?: number
          logged_purchase_cents?: number | null
          manual_purchase_cents?: number | null
          month_start: string
          month_start_at: string
          notes?: string | null
          opened_by?: string | null
          opened_by_name?: string | null
          opening_adjustment_cents?: number
          opening_snapshot_id: string
          property_id: string
          purchase_source?: string | null
          quality_flags?: Json
          start_request_id?: string | null
          status?: string
          timezone: string
          uncosted_delivery_count?: number
          updated_at?: string
          usage_budget_by_key?: Json | null
          usage_budget_mode?: string | null
          usage_budget_total_cents?: number | null
        }
        Update: {
          activity_start_at?: string
          actual_usage_cents?: number | null
          allocation_mode?: string | null
          baseline_at?: string
          beginning_value_cents?: number | null
          budget_comparison_available?: boolean
          by_budget_key?: Json | null
          by_category?: Json | null
          by_item?: Json | null
          close_request_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_by_name?: string | null
          confirmed_purchase_cents?: number | null
          count_window_start_at?: string
          created_at?: string
          end_at?: string
          ending_snapshot_id?: string | null
          ending_value_cents?: number | null
          grace_end_at?: string
          id?: string
          is_partial?: boolean
          known_logged_purchase_cents?: number
          logged_delivery_count?: number
          logged_purchase_cents?: number | null
          manual_purchase_cents?: number | null
          month_start?: string
          month_start_at?: string
          notes?: string | null
          opened_by?: string | null
          opened_by_name?: string | null
          opening_adjustment_cents?: number
          opening_snapshot_id?: string
          property_id?: string
          purchase_source?: string | null
          quality_flags?: Json
          start_request_id?: string | null
          status?: string
          timezone?: string
          uncosted_delivery_count?: number
          updated_at?: string
          usage_budget_by_key?: Json | null
          usage_budget_mode?: string | null
          usage_budget_total_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_closes_ending_snapshot_id_property_id_fkey"
            columns: ["ending_snapshot_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_close_snapshots"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_closes_opening_snapshot_id_property_id_fkey"
            columns: ["opening_snapshot_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_close_snapshots"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_closes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_opening_adjustments: {
        Row: {
          actor_id: string | null
          actor_name: string | null
          created_at: string
          effective_at: string
          id: string
          item_id: string
          property_id: string
          quantity: number
          reason: string
          request_id: string
          stock_after: number
          stock_before: number
          unit_cost_cents: number
          value_cents: number
        }
        Insert: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          effective_at: string
          id?: string
          item_id: string
          property_id: string
          quantity: number
          reason?: string
          request_id: string
          stock_after: number
          stock_before: number
          unit_cost_cents: number
          value_cents: number
        }
        Update: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          effective_at?: string
          id?: string
          item_id?: string
          property_id?: string
          quantity?: number
          reason?: string
          request_id?: string
          stock_after?: number
          stock_before?: number
          unit_cost_cents?: number
          value_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "inventory_opening_adjustments_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_opening_adjustments_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
        ]
      }
      inventory_orders: {
        Row: {
          activity_sequence: number
          correction_event_id: string | null
          corrects_order_id: string | null
          created_at: string
          entry_kind: string
          id: string
          item_id: string
          item_name: string
          notes: string | null
          ordered_at: string | null
          property_id: string
          quantity: number
          quantity_cases: number | null
          received_at: string
          recorded_by_name: string | null
          recorded_by_user_id: string | null
          request_id: string | null
          total_cost: number | null
          unit_cost: number | null
          vendor_name: string | null
        }
        Insert: {
          activity_sequence?: number
          correction_event_id?: string | null
          corrects_order_id?: string | null
          created_at?: string
          entry_kind?: string
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          ordered_at?: string | null
          property_id: string
          quantity: number
          quantity_cases?: number | null
          received_at?: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          request_id?: string | null
          total_cost?: number | null
          unit_cost?: number | null
          vendor_name?: string | null
        }
        Update: {
          activity_sequence?: number
          correction_event_id?: string | null
          corrects_order_id?: string | null
          created_at?: string
          entry_kind?: string
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          ordered_at?: string | null
          property_id?: string
          quantity?: number
          quantity_cases?: number | null
          received_at?: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          request_id?: string | null
          total_cost?: number | null
          unit_cost?: number | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_orders_correction_event_property_fkey"
            columns: ["correction_event_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_corrections"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_corrects_order_property_fkey"
            columns: ["corrects_order_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_orders"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_rate_predictions: {
        Row: {
          id: string
          is_shadow: boolean
          item_id: string
          item_name: string
          model_run_id: string
          predicted_at: string
          predicted_current_stock: number | null
          predicted_daily_rate: number
          predicted_daily_rate_p10: number | null
          predicted_daily_rate_p25: number | null
          predicted_daily_rate_p50: number | null
          predicted_daily_rate_p75: number | null
          predicted_daily_rate_p90: number | null
          predicted_for_date: string
          property_id: string
        }
        Insert: {
          id?: string
          is_shadow?: boolean
          item_id: string
          item_name: string
          model_run_id: string
          predicted_at?: string
          predicted_current_stock?: number | null
          predicted_daily_rate: number
          predicted_daily_rate_p10?: number | null
          predicted_daily_rate_p25?: number | null
          predicted_daily_rate_p50?: number | null
          predicted_daily_rate_p75?: number | null
          predicted_daily_rate_p90?: number | null
          predicted_for_date: string
          property_id: string
        }
        Update: {
          id?: string
          is_shadow?: boolean
          item_id?: string
          item_name?: string
          model_run_id?: string
          predicted_at?: string
          predicted_current_stock?: number | null
          predicted_daily_rate?: number
          predicted_daily_rate_p10?: number | null
          predicted_daily_rate_p25?: number | null
          predicted_daily_rate_p50?: number | null
          predicted_daily_rate_p75?: number | null
          predicted_daily_rate_p90?: number | null
          predicted_for_date?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_rate_predictions_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_model_property_item_fkey"
            columns: ["model_run_id", "property_id", "item_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id", "property_id", "item_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_rate_priors: {
        Row: {
          cohort_key: string
          id: string
          item_canonical_name: string
          n_hotels: number
          n_hotels_contributing: number
          prior_rate_per_room_per_day: number
          prior_strength: number
          rate_per_checkout_eq: number | null
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          item_canonical_name: string
          n_hotels?: number
          n_hotels_contributing?: number
          prior_rate_per_room_per_day: number
          prior_strength?: number
          rate_per_checkout_eq?: number | null
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          item_canonical_name?: string
          n_hotels?: number
          n_hotels_contributing?: number
          prior_rate_per_room_per_day?: number
          prior_strength?: number
          rate_per_checkout_eq?: number | null
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      inventory_reconciliations: {
        Row: {
          created_at: string
          discards_since_last: number
          id: string
          item_id: string
          item_name: string
          notes: string | null
          physical_count: number
          property_id: string
          reconciled_at: string
          reconciled_by: string | null
          recorded_by_name: string | null
          recorded_by_user_id: string | null
          system_estimate: number
          unaccounted_variance: number
          unaccounted_variance_value: number | null
          unit_cost: number | null
        }
        Insert: {
          created_at?: string
          discards_since_last?: number
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          physical_count: number
          property_id: string
          reconciled_at?: string
          reconciled_by?: string | null
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          system_estimate: number
          unaccounted_variance: number
          unaccounted_variance_value?: number | null
          unit_cost?: number | null
        }
        Update: {
          created_at?: string
          discards_since_last?: number
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          physical_count?: number
          property_id?: string
          reconciled_at?: string
          reconciled_by?: string | null
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          system_estimate?: number
          unaccounted_variance?: number
          unaccounted_variance_value?: number | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_reconciliations_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_reconciliations_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_reconciliations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_tab_layout_operations: {
        Row: {
          actor_id: string
          applied_layout: Json
          applied_revision: number
          created_at: string
          expected_revision: number
          operation_id: string
          property_id: string
          requested_budget_mode: string | null
          requested_layout: Json
        }
        Insert: {
          actor_id: string
          applied_layout: Json
          applied_revision: number
          created_at?: string
          expected_revision: number
          operation_id: string
          property_id: string
          requested_budget_mode?: string | null
          requested_layout: Json
        }
        Update: {
          actor_id?: string
          applied_layout?: Json
          applied_revision?: number
          created_at?: string
          expected_revision?: number
          operation_id?: string
          property_id?: string
          requested_budget_mode?: string | null
          requested_layout?: Json
        }
        Relationships: [
          {
            foreignKeyName: "inventory_tab_layout_operations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_write_receipts: {
        Row: {
          created_at: string
          operation: string
          payload: Json
          property_id: string
          request_id: string
          result: Json | null
        }
        Insert: {
          created_at?: string
          operation: string
          payload: Json
          property_id: string
          request_id: string
          result?: Json | null
        }
        Update: {
          created_at?: string
          operation?: string
          payload?: Json
          property_id?: string
          request_id?: string
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_write_receipts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      join_requests: {
        Row: {
          account_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          department: string
          id: string
          language: string
          name: string
          phone: string | null
          property_id: string
          status: string
        }
        Insert: {
          account_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          department: string
          id?: string
          language?: string
          name: string
          phone?: string | null
          property_id: string
          status?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          department?: string
          id?: string
          language?: string
          name?: string
          phone?: string | null
          property_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "join_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "join_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "join_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_articles: {
        Row: {
          body: string
          category: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          id: string
          property_id: string
          title: string
          updated_at: string
          updated_by: string | null
          updated_by_name: string | null
          visibility: string
        }
        Insert: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          property_id: string
          title: string
          updated_at?: string
          updated_by?: string | null
          updated_by_name?: string | null
          visibility?: string
        }
        Update: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          property_id?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_name?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_articles_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_chunks: {
        Row: {
          article_id: string | null
          char_count: number | null
          chunk_index: number
          content: string
          created_at: string
          document_id: string | null
          embedding: string | null
          id: string
          property_id: string
          section: string | null
          source_type: string
          visibility: string
          visible_dept: string | null
        }
        Insert: {
          article_id?: string | null
          char_count?: number | null
          chunk_index: number
          content: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          property_id: string
          section?: string | null
          source_type: string
          visibility?: string
          visible_dept?: string | null
        }
        Update: {
          article_id?: string | null
          char_count?: number | null
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          property_id?: string
          section?: string | null
          source_type?: string
          visibility?: string
          visible_dept?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_chunks_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "knowledge_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "knowledge_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_contacts: {
        Row: {
          address: string | null
          category: string | null
          city_state_zip: string | null
          company: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          email: string | null
          hours: string | null
          id: string
          local_category: string | null
          name: string
          notes: string | null
          phone: string | null
          property_id: string
        }
        Insert: {
          address?: string | null
          category?: string | null
          city_state_zip?: string | null
          company?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          email?: string | null
          hours?: string | null
          id?: string
          local_category?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          property_id: string
        }
        Update: {
          address?: string | null
          category?: string | null
          city_state_zip?: string | null
          company?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          email?: string | null
          hours?: string | null
          id?: string
          local_category?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_contacts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_documents: {
        Row: {
          created_at: string
          extract_error: string | null
          extracted_at: string | null
          extracted_text: string | null
          extraction_status: string
          file_path: string
          folder_id: string | null
          id: string
          mime_type: string | null
          property_id: string
          size_bytes: number | null
          title: string
          uploaded_by: string | null
          uploaded_by_name: string | null
          visibility: string
          visible_dept: string | null
        }
        Insert: {
          created_at?: string
          extract_error?: string | null
          extracted_at?: string | null
          extracted_text?: string | null
          extraction_status?: string
          file_path: string
          folder_id?: string | null
          id?: string
          mime_type?: string | null
          property_id: string
          size_bytes?: number | null
          title: string
          uploaded_by?: string | null
          uploaded_by_name?: string | null
          visibility?: string
          visible_dept?: string | null
        }
        Update: {
          created_at?: string
          extract_error?: string | null
          extracted_at?: string | null
          extracted_text?: string | null
          extraction_status?: string
          file_path?: string
          folder_id?: string | null
          id?: string
          mime_type?: string | null
          property_id?: string
          size_bytes?: number | null
          title?: string
          uploaded_by?: string | null
          uploaded_by_name?: string | null
          visibility?: string
          visible_dept?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "knowledge_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_documents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_events: {
        Row: {
          created_at: string
          created_by: string | null
          created_by_name: string | null
          end_date: string | null
          event_date: string
          id: string
          notes: string | null
          property_id: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          end_date?: string | null
          event_date: string
          id?: string
          notes?: string | null
          property_id: string
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          end_date?: string | null
          event_date?: string
          id?: string
          notes?: string | null
          property_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_folders: {
        Row: {
          created_at: string
          created_by: string | null
          created_by_name: string | null
          id: string
          name: string
          parent_id: string | null
          property_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          name: string
          parent_id?: string | null
          property_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          name?: string
          parent_id?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "knowledge_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_folders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_promotions: {
        Row: {
          applied_property_ids: string[]
          approved_at: string | null
          claim: string
          created_at: string
          decided_at: string | null
          decided_by_account_id: string | null
          decision_note: string | null
          evidence_summary: string | null
          evidence_window_end: string | null
          evidence_window_start: string | null
          expires_at: string | null
          final_content: string | null
          holdout_validated: boolean
          id: string
          is_aggregate: boolean
          observation_count: number
          origin: string
          pms_family: string | null
          preconditions: string[]
          previous_target_row_id: string | null
          proposed_content: string
          reconfirm_count: number
          reconfirmed_at: string | null
          retracted_at: string | null
          source_kind: string
          source_property_ids: string[]
          source_ref: string | null
          source_tier: string | null
          status: string
          supporting_hotel_count: number
          target_row_id: string | null
          target_table: string | null
          target_tier: string
          topic: string
          updated_at: string
        }
        Insert: {
          applied_property_ids?: string[]
          approved_at?: string | null
          claim: string
          created_at?: string
          decided_at?: string | null
          decided_by_account_id?: string | null
          decision_note?: string | null
          evidence_summary?: string | null
          evidence_window_end?: string | null
          evidence_window_start?: string | null
          expires_at?: string | null
          final_content?: string | null
          holdout_validated?: boolean
          id?: string
          is_aggregate?: boolean
          observation_count?: number
          origin: string
          pms_family?: string | null
          preconditions?: string[]
          previous_target_row_id?: string | null
          proposed_content: string
          reconfirm_count?: number
          reconfirmed_at?: string | null
          retracted_at?: string | null
          source_kind: string
          source_property_ids?: string[]
          source_ref?: string | null
          source_tier?: string | null
          status?: string
          supporting_hotel_count?: number
          target_row_id?: string | null
          target_table?: string | null
          target_tier: string
          topic: string
          updated_at?: string
        }
        Update: {
          applied_property_ids?: string[]
          approved_at?: string | null
          claim?: string
          created_at?: string
          decided_at?: string | null
          decided_by_account_id?: string | null
          decision_note?: string | null
          evidence_summary?: string | null
          evidence_window_end?: string | null
          evidence_window_start?: string | null
          expires_at?: string | null
          final_content?: string | null
          holdout_validated?: boolean
          id?: string
          is_aggregate?: boolean
          observation_count?: number
          origin?: string
          pms_family?: string | null
          preconditions?: string[]
          previous_target_row_id?: string | null
          proposed_content?: string
          reconfirm_count?: number
          reconfirmed_at?: string | null
          retracted_at?: string | null
          source_kind?: string
          source_property_ids?: string[]
          source_ref?: string | null
          source_tier?: string | null
          status?: string
          supporting_hotel_count?: number
          target_row_id?: string | null
          target_table?: string | null
          target_tier?: string
          topic?: string
          updated_at?: string
        }
        Relationships: []
      }
      labor_wage_settings: {
        Row: {
          created_at: string
          hourly_wage_cents: number
          id: string
          property_id: string
          role: string | null
          scope: string
          staff_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          hourly_wage_cents: number
          id?: string
          property_id: string
          role?: string | null
          scope: string
          staff_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          hourly_wage_cents?: number
          id?: string
          property_id?: string
          role?: string | null
          scope?: string
          staff_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "labor_wage_settings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "labor_wage_settings_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      laundry_completion: {
        Row: {
          completed_area_ids: string[]
          completed_load_categories: string[]
          property_id: string
          shift_date: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          completed_area_ids?: string[]
          completed_load_categories?: string[]
          property_id: string
          shift_date: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          completed_area_ids?: string[]
          completed_load_categories?: string[]
          property_id?: string
          shift_date?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "laundry_completion_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "laundry_completion_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      laundry_config: {
        Row: {
          created_at: string
          id: string
          minutes_per_load: number
          name: string
          property_id: string
          room_equivs_per_load: number
          stayover_factor: number
          two_bed_multiplier: number
          units_per_checkout: number
        }
        Insert: {
          created_at?: string
          id?: string
          minutes_per_load?: number
          name: string
          property_id: string
          room_equivs_per_load?: number
          stayover_factor?: number
          two_bed_multiplier?: number
          units_per_checkout?: number
        }
        Update: {
          created_at?: string
          id?: string
          minutes_per_load?: number
          name?: string
          property_id?: string
          room_equivs_per_load?: number
          stayover_factor?: number
          two_bed_multiplier?: number
          units_per_checkout?: number
        }
        Relationships: [
          {
            foreignKeyName: "laundry_config_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      local_worktrees: {
        Row: {
          branch: string | null
          commits_ahead: number
          commits_behind: number
          dirty_files: number
          head_committed_at: string | null
          head_message: string | null
          host: string
          last_seen: string
          name: string
        }
        Insert: {
          branch?: string | null
          commits_ahead?: number
          commits_behind?: number
          dirty_files?: number
          head_committed_at?: string | null
          head_message?: string | null
          host?: string
          last_seen?: string
          name: string
        }
        Update: {
          branch?: string | null
          commits_ahead?: number
          commits_behind?: number
          dirty_files?: number
          head_committed_at?: string | null
          head_message?: string | null
          host?: string
          last_seen?: string
          name?: string
        }
        Relationships: []
      }
      lost_and_found_items: {
        Row: {
          category: string | null
          claimed_at: string | null
          created_at: string
          created_by_account_id: string | null
          found_by: string | null
          found_by_staff_id: string | null
          guest_contact: string | null
          guest_name: string | null
          hold_until: string | null
          id: string
          item_description: string
          location: string | null
          matched_item_id: string | null
          notes: string | null
          occurred_at: string | null
          photo_path: string | null
          property_id: string
          reported_by: string | null
          returned_at: string | null
          room_number: string | null
          shipping_info: Json | null
          source: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_account_id?: string | null
          found_by?: string | null
          found_by_staff_id?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          hold_until?: string | null
          id?: string
          item_description: string
          location?: string | null
          matched_item_id?: string | null
          notes?: string | null
          occurred_at?: string | null
          photo_path?: string | null
          property_id: string
          reported_by?: string | null
          returned_at?: string | null
          room_number?: string | null
          shipping_info?: Json | null
          source?: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_account_id?: string | null
          found_by?: string | null
          found_by_staff_id?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          hold_until?: string | null
          id?: string
          item_description?: string
          location?: string | null
          matched_item_id?: string | null
          notes?: string | null
          occurred_at?: string | null
          photo_path?: string | null
          property_id?: string
          reported_by?: string | null
          returned_at?: string | null
          room_number?: string | null
          shipping_info?: Json | null
          source?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lost_and_found_items_matched_item_id_fkey"
            columns: ["matched_item_id"]
            isOneToOne: false
            referencedRelation: "lost_and_found_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_and_found_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      management_pattern_candidate_local_instances: {
        Row: {
          candidate_id: string
          created_at: string
          local_finding_id: string | null
          local_finding_snapshot: Json
          local_instance_id: string
          occurrence_at: string
          occurrence_evidence: Json
          organization_id: string
          property_id: string
          run_fencing_token: number
          run_id: string
        }
        Insert: {
          candidate_id: string
          created_at?: string
          local_finding_id?: string | null
          local_finding_snapshot?: Json
          local_instance_id: string
          occurrence_at: string
          occurrence_evidence?: Json
          organization_id: string
          property_id: string
          run_fencing_token: number
          run_id: string
        }
        Update: {
          candidate_id?: string
          created_at?: string
          local_finding_id?: string | null
          local_finding_snapshot?: Json
          local_instance_id?: string
          occurrence_at?: string
          occurrence_evidence?: Json
          organization_id?: string
          property_id?: string
          run_fencing_token?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_candidate_local_instan_local_finding_id_fkey"
            columns: ["local_finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "management_pattern_local_instances_candidate_fkey"
            columns: ["organization_id", "candidate_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_candidates"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_local_instances_candidate_property_fkey"
            columns: ["organization_id", "candidate_id", "property_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_candidate_properties"
            referencedColumns: [
              "organization_id",
              "candidate_id",
              "property_id",
            ]
          },
        ]
      }
      management_pattern_candidate_outcomes: {
        Row: {
          candidate_id: string
          check_outcome_id: string
          created_at: string
          lineage_role: string
          manifestation_evidence: Json
          manifestation_key: string
          organization_id: string
          run_fencing_token: number
          run_id: string
        }
        Insert: {
          candidate_id: string
          check_outcome_id: string
          created_at?: string
          lineage_role: string
          manifestation_evidence?: Json
          manifestation_key: string
          organization_id: string
          run_fencing_token: number
          run_id: string
        }
        Update: {
          candidate_id?: string
          check_outcome_id?: string
          created_at?: string
          lineage_role?: string
          manifestation_evidence?: Json
          manifestation_key?: string
          organization_id?: string
          run_fencing_token?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_candidate_outcomes_candidate_fkey"
            columns: ["organization_id", "candidate_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_candidates"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_candidate_outcomes_outcome_fkey"
            columns: ["organization_id", "check_outcome_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_check_outcomes"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
        ]
      }
      management_pattern_candidate_properties: {
        Row: {
          candidate_id: string
          created_at: string
          exclusion_codes: string[]
          occurrence_evidence: Json
          occurrence_role: string
          organization_id: string
          property_id: string
          run_fencing_token: number
          run_id: string
        }
        Insert: {
          candidate_id: string
          created_at?: string
          exclusion_codes?: string[]
          occurrence_evidence?: Json
          occurrence_role: string
          organization_id: string
          property_id: string
          run_fencing_token: number
          run_id: string
        }
        Update: {
          candidate_id?: string
          created_at?: string
          exclusion_codes?: string[]
          occurrence_evidence?: Json
          occurrence_role?: string
          organization_id?: string
          property_id?: string
          run_fencing_token?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_candidate_properties_candidate_fkey"
            columns: ["organization_id", "candidate_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_candidates"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_candidate_properties_run_property_fkey"
            columns: ["organization_id", "run_id", "property_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_run_properties"
            referencedColumns: ["organization_id", "run_id", "property_id"]
          },
        ]
      }
      management_pattern_candidates: {
        Row: {
          candidate_hash: string
          candidate_key: string
          candidate_schema_version: number
          check_outcome_id: string
          classified_scope: string | null
          confidence: number
          confidence_kind: string
          created_at: string
          decision: string
          disposition: string
          effective_at: string
          escalation_factor: number | null
          escalation_min_delta: number | null
          evidence: Json
          id: string
          magnitude: number
          materiality_score: number
          organization_id: string
          price_basis: string | null
          price_currency_code: string | null
          price_high_cents: number | null
          price_low_cents: number | null
          projection_dedupe_key: string
          quality_metadata: Json
          receipt_query_id: string
          root_key: string
          routing_metadata: Json
          run_fencing_token: number
          run_id: string
          scope_evidence: Json
          semantic_family: string
          severity: string
          summary: string
          suppression_reasons: string[]
          weakest_input_age_days: number | null
        }
        Insert: {
          candidate_hash: string
          candidate_key: string
          candidate_schema_version?: number
          check_outcome_id: string
          classified_scope?: string | null
          confidence: number
          confidence_kind: string
          created_at?: string
          decision: string
          disposition: string
          effective_at: string
          escalation_factor?: number | null
          escalation_min_delta?: number | null
          evidence: Json
          id: string
          magnitude: number
          materiality_score: number
          organization_id: string
          price_basis?: string | null
          price_currency_code?: string | null
          price_high_cents?: number | null
          price_low_cents?: number | null
          projection_dedupe_key: string
          quality_metadata?: Json
          receipt_query_id: string
          root_key: string
          routing_metadata?: Json
          run_fencing_token: number
          run_id: string
          scope_evidence: Json
          semantic_family: string
          severity: string
          summary: string
          suppression_reasons?: string[]
          weakest_input_age_days?: number | null
        }
        Update: {
          candidate_hash?: string
          candidate_key?: string
          candidate_schema_version?: number
          check_outcome_id?: string
          classified_scope?: string | null
          confidence?: number
          confidence_kind?: string
          created_at?: string
          decision?: string
          disposition?: string
          effective_at?: string
          escalation_factor?: number | null
          escalation_min_delta?: number | null
          evidence?: Json
          id?: string
          magnitude?: number
          materiality_score?: number
          organization_id?: string
          price_basis?: string | null
          price_currency_code?: string | null
          price_high_cents?: number | null
          price_low_cents?: number | null
          projection_dedupe_key?: string
          quality_metadata?: Json
          receipt_query_id?: string
          root_key?: string
          routing_metadata?: Json
          run_fencing_token?: number
          run_id?: string
          scope_evidence?: Json
          semantic_family?: string
          severity?: string
          summary?: string
          suppression_reasons?: string[]
          weakest_input_age_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_candidates_outcome_fkey"
            columns: ["organization_id", "check_outcome_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_check_outcomes"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
        ]
      }
      management_pattern_check_observations: {
        Row: {
          check_outcome_id: string
          created_at: string
          observation_id: string
          organization_id: string
          run_fencing_token: number
          run_id: string
          usage_role: string
        }
        Insert: {
          check_outcome_id: string
          created_at?: string
          observation_id: string
          organization_id: string
          run_fencing_token: number
          run_id: string
          usage_role: string
        }
        Update: {
          check_outcome_id?: string
          created_at?: string
          observation_id?: string
          organization_id?: string
          run_fencing_token?: number
          run_id?: string
          usage_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_check_observations_observation_fkey"
            columns: ["organization_id", "observation_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_metric_observations"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_check_observations_outcome_fkey"
            columns: ["organization_id", "check_outcome_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_check_outcomes"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
        ]
      }
      management_pattern_check_outcomes: {
        Row: {
          candidate_count: number
          check_id: string
          check_version: string
          cohort_id: string | null
          created_at: string
          deterministic: boolean
          duration_ms: number
          evidence: Json
          id: string
          input_hash: string
          organization_id: string
          outcome_hash: string
          outcome_key: string
          parameters: Json
          quality_gate: string
          reason_codes: string[]
          result: string
          root_domain_key: string
          rows_examined: number
          run_fencing_token: number
          run_id: string
          semantic_family: string
          target_property_id: string | null
        }
        Insert: {
          candidate_count?: number
          check_id: string
          check_version: string
          cohort_id?: string | null
          created_at?: string
          deterministic?: boolean
          duration_ms?: number
          evidence?: Json
          id: string
          input_hash: string
          organization_id: string
          outcome_hash: string
          outcome_key: string
          parameters?: Json
          quality_gate: string
          reason_codes?: string[]
          result: string
          root_domain_key: string
          rows_examined?: number
          run_fencing_token: number
          run_id: string
          semantic_family: string
          target_property_id?: string | null
        }
        Update: {
          candidate_count?: number
          check_id?: string
          check_version?: string
          cohort_id?: string | null
          created_at?: string
          deterministic?: boolean
          duration_ms?: number
          evidence?: Json
          id?: string
          input_hash?: string
          organization_id?: string
          outcome_hash?: string
          outcome_key?: string
          parameters?: Json
          quality_gate?: string
          reason_codes?: string[]
          result?: string
          root_domain_key?: string
          rows_examined?: number
          run_fencing_token?: number
          run_id?: string
          semantic_family?: string
          target_property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_outcomes_cohort_fkey"
            columns: ["organization_id", "cohort_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_cohorts"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_outcomes_run_fkey"
            columns: ["organization_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "management_pattern_outcomes_target_fkey"
            columns: ["organization_id", "run_id", "target_property_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_run_properties"
            referencedColumns: ["organization_id", "run_id", "property_id"]
          },
        ]
      }
      management_pattern_cohort_members: {
        Row: {
          cohort_id: string
          comparison_weight: number | null
          created_at: string
          decision_reason: string
          distance_score: number | null
          exclusion_codes: string[]
          member_role: string
          membership_status: string
          normalized_dimensions: Json
          organization_id: string
          profile_id: string | null
          property_id: string
          run_fencing_token: number
          run_id: string
        }
        Insert: {
          cohort_id: string
          comparison_weight?: number | null
          created_at?: string
          decision_reason: string
          distance_score?: number | null
          exclusion_codes?: string[]
          member_role: string
          membership_status: string
          normalized_dimensions?: Json
          organization_id: string
          profile_id?: string | null
          property_id: string
          run_fencing_token: number
          run_id: string
        }
        Update: {
          cohort_id?: string
          comparison_weight?: number | null
          created_at?: string
          decision_reason?: string
          distance_score?: number | null
          exclusion_codes?: string[]
          member_role?: string
          membership_status?: string
          normalized_dimensions?: Json
          organization_id?: string
          profile_id?: string | null
          property_id?: string
          run_fencing_token?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_cohort_members_cohort_fkey"
            columns: ["organization_id", "cohort_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_cohorts"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_cohort_members_run_property_fkey"
            columns: ["organization_id", "run_id", "property_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_run_properties"
            referencedColumns: ["organization_id", "run_id", "property_id"]
          },
        ]
      }
      management_pattern_cohorts: {
        Row: {
          abstention_reason: string | null
          cohort_key: string
          created_at: string
          definition: Json
          definition_hash: string
          definition_version: string
          dimension_keys: string[]
          eligible_member_count: number
          excluded_member_count: number
          fallback_level: number
          id: string
          included_member_count: number
          minimum_member_count: number
          organization_id: string
          quality: Json
          run_fencing_token: number
          run_id: string
          status: string
          target_property_id: string | null
        }
        Insert: {
          abstention_reason?: string | null
          cohort_key: string
          created_at?: string
          definition: Json
          definition_hash: string
          definition_version: string
          dimension_keys?: string[]
          eligible_member_count?: number
          excluded_member_count?: number
          fallback_level?: number
          id: string
          included_member_count?: number
          minimum_member_count: number
          organization_id: string
          quality?: Json
          run_fencing_token: number
          run_id: string
          status: string
          target_property_id?: string | null
        }
        Update: {
          abstention_reason?: string | null
          cohort_key?: string
          created_at?: string
          definition?: Json
          definition_hash?: string
          definition_version?: string
          dimension_keys?: string[]
          eligible_member_count?: number
          excluded_member_count?: number
          fallback_level?: number
          id?: string
          included_member_count?: number
          minimum_member_count?: number
          organization_id?: string
          quality?: Json
          run_fencing_token?: number
          run_id?: string
          status?: string
          target_property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_cohorts_run_fkey"
            columns: ["organization_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "management_pattern_cohorts_target_fkey"
            columns: ["organization_id", "run_id", "target_property_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_run_properties"
            referencedColumns: ["organization_id", "run_id", "property_id"]
          },
        ]
      }
      management_pattern_metric_observations: {
        Row: {
          as_of: string
          business_date_cutoff_hour: number | null
          cohort_id: string | null
          completeness_ratio: number
          created_at: string
          currency_conversion_as_of: string | null
          currency_conversion_rate: number | null
          currency_conversion_source_query_id: string | null
          currency_conversion_source_query_version: string | null
          currency_conversion_source_snapshot_hash: string | null
          denominator_as_of: string | null
          denominator_business_date_cutoff_hour: number | null
          denominator_completeness_ratio: number | null
          denominator_freshness_age_seconds: number | null
          denominator_key: string | null
          denominator_source_query: Json | null
          denominator_source_query_id: string | null
          denominator_source_query_version: string | null
          denominator_source_snapshot_hash: string | null
          denominator_source_watermark: Json | null
          denominator_unit: string | null
          denominator_value: number | null
          denominator_window_end_local: string | null
          denominator_window_end_utc: string | null
          denominator_window_kind: string | null
          denominator_window_start_local: string | null
          denominator_window_start_utc: string | null
          denominator_window_timezone: string | null
          freshness_age_seconds: number
          id: string
          metadata: Json
          metric_key: string
          metric_version: string
          normalization_definition_hash: string | null
          normalization_method: string | null
          normalization_policy_version: string | null
          normalization_window_alignment: string | null
          normalized_currency_code: string | null
          normalized_currency_minor_unit_exponent: number | null
          normalized_unit: string | null
          normalized_value: number | null
          organization_id: string
          property_id: string
          quality_reasons: string[]
          quality_status: string
          raw_currency_code: string | null
          raw_currency_minor_unit_exponent: number | null
          raw_unit: string
          raw_value: number | null
          run_fencing_token: number
          run_id: string
          source_query: Json
          source_query_id: string
          source_query_version: string
          source_snapshot_hash: string
          source_watermark: Json
          window_end_local: string
          window_end_utc: string
          window_kind: string
          window_start_local: string
          window_start_utc: string
          window_timezone: string
        }
        Insert: {
          as_of: string
          business_date_cutoff_hour?: number | null
          cohort_id?: string | null
          completeness_ratio: number
          created_at?: string
          currency_conversion_as_of?: string | null
          currency_conversion_rate?: number | null
          currency_conversion_source_query_id?: string | null
          currency_conversion_source_query_version?: string | null
          currency_conversion_source_snapshot_hash?: string | null
          denominator_as_of?: string | null
          denominator_business_date_cutoff_hour?: number | null
          denominator_completeness_ratio?: number | null
          denominator_freshness_age_seconds?: number | null
          denominator_key?: string | null
          denominator_source_query?: Json | null
          denominator_source_query_id?: string | null
          denominator_source_query_version?: string | null
          denominator_source_snapshot_hash?: string | null
          denominator_source_watermark?: Json | null
          denominator_unit?: string | null
          denominator_value?: number | null
          denominator_window_end_local?: string | null
          denominator_window_end_utc?: string | null
          denominator_window_kind?: string | null
          denominator_window_start_local?: string | null
          denominator_window_start_utc?: string | null
          denominator_window_timezone?: string | null
          freshness_age_seconds: number
          id: string
          metadata?: Json
          metric_key: string
          metric_version: string
          normalization_definition_hash?: string | null
          normalization_method?: string | null
          normalization_policy_version?: string | null
          normalization_window_alignment?: string | null
          normalized_currency_code?: string | null
          normalized_currency_minor_unit_exponent?: number | null
          normalized_unit?: string | null
          normalized_value?: number | null
          organization_id: string
          property_id: string
          quality_reasons?: string[]
          quality_status: string
          raw_currency_code?: string | null
          raw_currency_minor_unit_exponent?: number | null
          raw_unit: string
          raw_value?: number | null
          run_fencing_token: number
          run_id: string
          source_query: Json
          source_query_id: string
          source_query_version: string
          source_snapshot_hash: string
          source_watermark?: Json
          window_end_local: string
          window_end_utc: string
          window_kind: string
          window_start_local: string
          window_start_utc: string
          window_timezone: string
        }
        Update: {
          as_of?: string
          business_date_cutoff_hour?: number | null
          cohort_id?: string | null
          completeness_ratio?: number
          created_at?: string
          currency_conversion_as_of?: string | null
          currency_conversion_rate?: number | null
          currency_conversion_source_query_id?: string | null
          currency_conversion_source_query_version?: string | null
          currency_conversion_source_snapshot_hash?: string | null
          denominator_as_of?: string | null
          denominator_business_date_cutoff_hour?: number | null
          denominator_completeness_ratio?: number | null
          denominator_freshness_age_seconds?: number | null
          denominator_key?: string | null
          denominator_source_query?: Json | null
          denominator_source_query_id?: string | null
          denominator_source_query_version?: string | null
          denominator_source_snapshot_hash?: string | null
          denominator_source_watermark?: Json | null
          denominator_unit?: string | null
          denominator_value?: number | null
          denominator_window_end_local?: string | null
          denominator_window_end_utc?: string | null
          denominator_window_kind?: string | null
          denominator_window_start_local?: string | null
          denominator_window_start_utc?: string | null
          denominator_window_timezone?: string | null
          freshness_age_seconds?: number
          id?: string
          metadata?: Json
          metric_key?: string
          metric_version?: string
          normalization_definition_hash?: string | null
          normalization_method?: string | null
          normalization_policy_version?: string | null
          normalization_window_alignment?: string | null
          normalized_currency_code?: string | null
          normalized_currency_minor_unit_exponent?: number | null
          normalized_unit?: string | null
          normalized_value?: number | null
          organization_id?: string
          property_id?: string
          quality_reasons?: string[]
          quality_status?: string
          raw_currency_code?: string | null
          raw_currency_minor_unit_exponent?: number | null
          raw_unit?: string
          raw_value?: number | null
          run_fencing_token?: number
          run_id?: string
          source_query?: Json
          source_query_id?: string
          source_query_version?: string
          source_snapshot_hash?: string
          source_watermark?: Json
          window_end_local?: string
          window_end_utc?: string
          window_kind?: string
          window_start_local?: string
          window_start_utc?: string
          window_timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_observations_cohort_fkey"
            columns: ["organization_id", "cohort_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_cohorts"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_observations_run_property_fkey"
            columns: ["organization_id", "run_id", "property_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_run_properties"
            referencedColumns: ["organization_id", "run_id", "property_id"]
          },
        ]
      }
      management_pattern_metric_source_facts: {
        Row: {
          created_at: string
          fact_hash: string
          fact_key: string
          fact_kind: string
          fact_payload: Json
          fact_role: string
          included_in_aggregate: boolean
          numeric_value: number | null
          observation_id: string
          organization_id: string
          run_fencing_token: number
          run_id: string
          source_query_id: string
          source_query_version: string
          source_recorded_at: string
        }
        Insert: {
          created_at?: string
          fact_hash: string
          fact_key: string
          fact_kind: string
          fact_payload: Json
          fact_role: string
          included_in_aggregate: boolean
          numeric_value?: number | null
          observation_id: string
          organization_id: string
          run_fencing_token: number
          run_id: string
          source_query_id: string
          source_query_version: string
          source_recorded_at: string
        }
        Update: {
          created_at?: string
          fact_hash?: string
          fact_key?: string
          fact_kind?: string
          fact_payload?: Json
          fact_role?: string
          included_in_aggregate?: boolean
          numeric_value?: number | null
          observation_id?: string
          organization_id?: string
          run_fencing_token?: number
          run_id?: string
          source_query_id?: string
          source_query_version?: string
          source_recorded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_source_facts_observation_fkey"
            columns: ["organization_id", "observation_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_metric_observations"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
        ]
      }
      management_pattern_projection_locks: {
        Row: {
          created_at: string
          organization_id: string
          root_key: string
          semantic_family: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          root_key: string
          semantic_family: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          root_key?: string
          semantic_family?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_projection_locks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      management_pattern_property_profiles: {
        Row: {
          amenity_tags: string[] | null
          brand_class: string | null
          business_date_cutoff_hour: number | null
          change_reason: string
          comparison_attributes: Json
          created_at: string
          created_by_account_id: string | null
          currency_code: string | null
          currency_minor_unit_exponent: number | null
          effective_from: string
          effective_to: string | null
          id: string
          location_type: string | null
          market_type: string | null
          operating_model: string | null
          organization_id: string
          profile_version: number
          property_id: string
          property_relationship_id: string
          room_count: number | null
          service_level: string | null
          source_kind: string
          source_reference: string | null
          timezone_name: string | null
        }
        Insert: {
          amenity_tags?: string[] | null
          brand_class?: string | null
          business_date_cutoff_hour?: number | null
          change_reason: string
          comparison_attributes?: Json
          created_at?: string
          created_by_account_id?: string | null
          currency_code?: string | null
          currency_minor_unit_exponent?: number | null
          effective_from: string
          effective_to?: string | null
          id?: string
          location_type?: string | null
          market_type?: string | null
          operating_model?: string | null
          organization_id: string
          profile_version: number
          property_id: string
          property_relationship_id: string
          room_count?: number | null
          service_level?: string | null
          source_kind: string
          source_reference?: string | null
          timezone_name?: string | null
        }
        Update: {
          amenity_tags?: string[] | null
          brand_class?: string | null
          business_date_cutoff_hour?: number | null
          change_reason?: string
          comparison_attributes?: Json
          created_at?: string
          created_by_account_id?: string | null
          currency_code?: string | null
          currency_minor_unit_exponent?: number | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          location_type?: string | null
          market_type?: string | null
          operating_model?: string | null
          organization_id?: string
          profile_version?: number
          property_id?: string
          property_relationship_id?: string
          room_count?: number | null
          service_level?: string | null
          source_kind?: string
          source_reference?: string | null
          timezone_name?: string | null
        }
        Relationships: []
      }
      management_pattern_reconciliation_outcomes: {
        Row: {
          check_outcome_id: string
          created_at: string
          lineage_role: string
          organization_id: string
          reconciliation_id: string
          run_fencing_token: number
          run_id: string
        }
        Insert: {
          check_outcome_id: string
          created_at?: string
          lineage_role: string
          organization_id: string
          reconciliation_id: string
          run_fencing_token: number
          run_id: string
        }
        Update: {
          check_outcome_id?: string
          created_at?: string
          lineage_role?: string
          organization_id?: string
          reconciliation_id?: string
          run_fencing_token?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_reconciliation_outcomes_outcome_fkey"
            columns: ["organization_id", "check_outcome_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_check_outcomes"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_reconciliation_outcomes_reconciliation_fkey"
            columns: ["organization_id", "reconciliation_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_reconciliations"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
        ]
      }
      management_pattern_reconciliations: {
        Row: {
          candidate_id: string | null
          check_outcome_id: string
          conclusion: string
          created_at: string
          detector_ids: string[]
          detector_versions: Json
          effective_at: string
          evidence: Json
          id: string
          organization_id: string
          reconciliation_hash: string
          root_domain_key: string
          root_key: string
          run_fencing_token: number
          run_id: string
          semantic_family: string
        }
        Insert: {
          candidate_id?: string | null
          check_outcome_id: string
          conclusion: string
          created_at?: string
          detector_ids: string[]
          detector_versions: Json
          effective_at: string
          evidence?: Json
          id: string
          organization_id: string
          reconciliation_hash: string
          root_domain_key: string
          root_key: string
          run_fencing_token: number
          run_id: string
          semantic_family: string
        }
        Update: {
          candidate_id?: string | null
          check_outcome_id?: string
          conclusion?: string
          created_at?: string
          detector_ids?: string[]
          detector_versions?: Json
          effective_at?: string
          evidence?: Json
          id?: string
          organization_id?: string
          reconciliation_hash?: string
          root_domain_key?: string
          root_key?: string
          run_fencing_token?: number
          run_id?: string
          semantic_family?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_reconciliations_candidate_fkey"
            columns: ["organization_id", "candidate_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_candidates"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
          {
            foreignKeyName: "management_pattern_reconciliations_manifest_fkey"
            columns: [
              "organization_id",
              "run_id",
              "semantic_family",
              "root_key",
            ]
            isOneToOne: true
            referencedRelation: "management_pattern_run_roots"
            referencedColumns: [
              "organization_id",
              "run_id",
              "semantic_family",
              "root_key",
            ]
          },
          {
            foreignKeyName: "management_pattern_reconciliations_outcome_fkey"
            columns: ["organization_id", "check_outcome_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_check_outcomes"
            referencedColumns: ["organization_id", "id", "run_id"]
          },
        ]
      }
      management_pattern_result_batches: {
        Row: {
          batch_hash: string
          created_at: string
          organization_id: string
          row_counts: Json
          run_fencing_token: number
          run_id: string
        }
        Insert: {
          batch_hash: string
          created_at?: string
          organization_id: string
          row_counts: Json
          run_fencing_token: number
          run_id: string
        }
        Update: {
          batch_hash?: string
          created_at?: string
          organization_id?: string
          row_counts?: Json
          run_fencing_token?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_result_batches_run_fkey"
            columns: ["organization_id", "run_id"]
            isOneToOne: true
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      management_pattern_run_locks: {
        Row: {
          created_at: string
          organization_id: string
          run_key: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          run_key: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          run_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_run_locks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      management_pattern_run_properties: {
        Row: {
          business_date_cutoff_hour: number | null
          created_at: string
          currency_code: string | null
          currency_minor_unit_exponent: number | null
          eligibility_status: string
          exclusion_codes: string[]
          membership_relationship_id: string
          membership_snapshot: Json
          organization_id: string
          profile_id: string | null
          profile_snapshot: Json
          property_id: string
          property_name: string
          property_snapshot_hash: string
          run_fencing_token: number
          run_id: string
          timezone_name: string | null
        }
        Insert: {
          business_date_cutoff_hour?: number | null
          created_at?: string
          currency_code?: string | null
          currency_minor_unit_exponent?: number | null
          eligibility_status: string
          exclusion_codes?: string[]
          membership_relationship_id: string
          membership_snapshot: Json
          organization_id: string
          profile_id?: string | null
          profile_snapshot?: Json
          property_id: string
          property_name: string
          property_snapshot_hash: string
          run_fencing_token: number
          run_id: string
          timezone_name?: string | null
        }
        Update: {
          business_date_cutoff_hour?: number | null
          created_at?: string
          currency_code?: string | null
          currency_minor_unit_exponent?: number | null
          eligibility_status?: string
          exclusion_codes?: string[]
          membership_relationship_id?: string
          membership_snapshot?: Json
          organization_id?: string
          profile_id?: string | null
          profile_snapshot?: Json
          property_id?: string
          property_name?: string
          property_snapshot_hash?: string
          run_fencing_token?: number
          run_id?: string
          timezone_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_run_properties_run_fkey"
            columns: ["organization_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      management_pattern_run_roots: {
        Row: {
          created_at: string
          definition_hash: string
          detector_ids: string[]
          detector_versions: Json
          expected_outcome_count: number
          expected_outcome_keys: string[]
          expected_outcome_set_hash: string
          manifest_source: string
          organization_id: string
          root_domain_key: string
          root_key: string
          run_fencing_token: number
          run_id: string
          semantic_family: string
        }
        Insert: {
          created_at?: string
          definition_hash: string
          detector_ids: string[]
          detector_versions: Json
          expected_outcome_count: number
          expected_outcome_keys: string[]
          expected_outcome_set_hash: string
          manifest_source: string
          organization_id: string
          root_domain_key: string
          root_key: string
          run_fencing_token: number
          run_id: string
          semantic_family: string
        }
        Update: {
          created_at?: string
          definition_hash?: string
          detector_ids?: string[]
          detector_versions?: Json
          expected_outcome_count?: number
          expected_outcome_keys?: string[]
          expected_outcome_set_hash?: string
          manifest_source?: string
          organization_id?: string
          root_domain_key?: string
          root_key?: string
          run_fencing_token?: number
          run_id?: string
          semantic_family?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_run_roots_run_fkey"
            columns: ["organization_id", "run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      management_pattern_runs: {
        Row: {
          abstention_count: number
          attempt_count: number
          candidate_count: number
          check_count: number
          cohort_count: number
          cohort_member_count: number
          cohort_policy_version: string
          completed_at: string | null
          completion_token_count: number
          cost_budget_microusd: number
          cost_summary: Json
          created_at: string
          db_query_budget: number
          db_query_count: number
          dedupe_policy_version: string
          duration_budget_ms: number
          duration_ms: number | null
          engine_version: string
          error_detail: Json
          estimated_cost_microusd: number
          evaluation_at: string
          evidence_schema_version: number
          excluded_property_count: number
          fencing_token: number
          heartbeat_at: string
          id: string
          included_property_count: number
          input_hash: string
          input_manifest: Json
          lease_expires_at: string
          model_call_budget: number
          model_call_count: number
          model_versions: Json
          normalization_policy_version: string
          observation_count: number
          observation_link_count: number
          organization_id: string
          outcome_count: number
          owner_token: string
          performance_summary: Json
          portfolio_snapshot: Json
          portfolio_snapshot_hash: string
          projection_mode: string
          prompt_token_count: number
          property_count: number
          quality_failure_count: number
          quality_summary: Json
          run_key: string
          scope_policy_version: string
          source_as_of: string
          source_fact_count: number
          started_at: string
          status: string
          supersedes_run_id: string | null
          token_budget: number
          topology_as_of: string
          triggered_by: string
          window_end: string
          window_start: string
        }
        Insert: {
          abstention_count?: number
          attempt_count?: number
          candidate_count?: number
          check_count?: number
          cohort_count?: number
          cohort_member_count?: number
          cohort_policy_version: string
          completed_at?: string | null
          completion_token_count?: number
          cost_budget_microusd?: number
          cost_summary?: Json
          created_at?: string
          db_query_budget?: number
          db_query_count?: number
          dedupe_policy_version: string
          duration_budget_ms?: number
          duration_ms?: number | null
          engine_version: string
          error_detail?: Json
          estimated_cost_microusd?: number
          evaluation_at: string
          evidence_schema_version?: number
          excluded_property_count?: number
          fencing_token?: number
          heartbeat_at?: string
          id?: string
          included_property_count?: number
          input_hash: string
          input_manifest?: Json
          lease_expires_at: string
          model_call_budget?: number
          model_call_count?: number
          model_versions?: Json
          normalization_policy_version: string
          observation_count?: number
          observation_link_count?: number
          organization_id: string
          outcome_count?: number
          owner_token: string
          performance_summary?: Json
          portfolio_snapshot: Json
          portfolio_snapshot_hash: string
          projection_mode?: string
          prompt_token_count?: number
          property_count?: number
          quality_failure_count?: number
          quality_summary?: Json
          run_key: string
          scope_policy_version: string
          source_as_of: string
          source_fact_count?: number
          started_at?: string
          status?: string
          supersedes_run_id?: string | null
          token_budget?: number
          topology_as_of: string
          triggered_by?: string
          window_end: string
          window_start: string
        }
        Update: {
          abstention_count?: number
          attempt_count?: number
          candidate_count?: number
          check_count?: number
          cohort_count?: number
          cohort_member_count?: number
          cohort_policy_version?: string
          completed_at?: string | null
          completion_token_count?: number
          cost_budget_microusd?: number
          cost_summary?: Json
          created_at?: string
          db_query_budget?: number
          db_query_count?: number
          dedupe_policy_version?: string
          duration_budget_ms?: number
          duration_ms?: number | null
          engine_version?: string
          error_detail?: Json
          estimated_cost_microusd?: number
          evaluation_at?: string
          evidence_schema_version?: number
          excluded_property_count?: number
          fencing_token?: number
          heartbeat_at?: string
          id?: string
          included_property_count?: number
          input_hash?: string
          input_manifest?: Json
          lease_expires_at?: string
          model_call_budget?: number
          model_call_count?: number
          model_versions?: Json
          normalization_policy_version?: string
          observation_count?: number
          observation_link_count?: number
          organization_id?: string
          outcome_count?: number
          owner_token?: string
          performance_summary?: Json
          portfolio_snapshot?: Json
          portfolio_snapshot_hash?: string
          projection_mode?: string
          prompt_token_count?: number
          property_count?: number
          quality_failure_count?: number
          quality_summary?: Json
          run_key?: string
          scope_policy_version?: string
          source_as_of?: string
          source_fact_count?: number
          started_at?: string
          status?: string
          supersedes_run_id?: string | null
          token_budget?: number
          topology_as_of?: string
          triggered_by?: string
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_pattern_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "management_pattern_runs_supersedes_fkey"
            columns: ["organization_id", "supersedes_run_id"]
            isOneToOne: false
            referencedRelation: "management_pattern_runs"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      manager_notifications: {
        Row: {
          created_at: string
          id: string
          message: string
          property_id: string
          read: boolean
          replacement_name: string | null
          shift_date: string
          staff_name: string | null
          type: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          property_id: string
          read?: boolean
          replacement_name?: string | null
          shift_date: string
          staff_name?: string | null
          type: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          property_id?: string
          read?: boolean
          replacement_name?: string | null
          shift_date?: string
          staff_name?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_notifications_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      manager_room_notes: {
        Row: {
          business_date: string
          created_at: string
          expires_at: string | null
          id: string
          note_lang: string | null
          note_text: string
          posted_at: string
          posted_by_account_id: string | null
          property_id: string
          room_number: string
        }
        Insert: {
          business_date: string
          created_at?: string
          expires_at?: string | null
          id?: string
          note_lang?: string | null
          note_text: string
          posted_at?: string
          posted_by_account_id?: string | null
          property_id: string
          room_number: string
        }
        Update: {
          business_date?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          note_lang?: string | null
          note_text?: string
          posted_at?: string
          posted_by_account_id?: string | null
          property_id?: string
          room_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_room_notes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mapper_job_watchers: {
        Row: {
          admin_user_id: string
          job_id: string
          last_seen_at: string
        }
        Insert: {
          admin_user_id: string
          job_id: string
          last_seen_at?: string
        }
        Update: {
          admin_user_id?: string
          job_id?: string
          last_seen_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mapper_job_watchers_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapper_job_watchers_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mapper_takeover_sessions: {
        Row: {
          admin_user_id: string | null
          applied_command_seq: number
          command: string | null
          command_coordinate: Json | null
          command_frame_seq: number | null
          command_note: string | null
          command_seq: number
          created_at: string
          ended_at: string | null
          ended_reason: string | null
          frame_seq: number
          id: string
          job_id: string
          requested_at: string
          started_at: string | null
          status: string
          target_key: string | null
          viewport_h: number
          viewport_w: number
        }
        Insert: {
          admin_user_id?: string | null
          applied_command_seq?: number
          command?: string | null
          command_coordinate?: Json | null
          command_frame_seq?: number | null
          command_note?: string | null
          command_seq?: number
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          frame_seq?: number
          id?: string
          job_id: string
          requested_at?: string
          started_at?: string | null
          status?: string
          target_key?: string | null
          viewport_h?: number
          viewport_w?: number
        }
        Update: {
          admin_user_id?: string | null
          applied_command_seq?: number
          command?: string | null
          command_coordinate?: Json | null
          command_frame_seq?: number | null
          command_note?: string | null
          command_seq?: number
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          frame_seq?: number
          id?: string
          job_id?: string
          requested_at?: string
          started_at?: string | null
          status?: string
          target_key?: string | null
          viewport_h?: number
          viewport_w?: number
        }
        Relationships: [
          {
            foreignKeyName: "mapper_takeover_sessions_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapper_takeover_sessions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_feed_captures: {
        Row: {
          created_at: string
          feed_key: string
          id: string
          job_id: string
          pms_family: string
          property_id: string
          screenshot_path: string
        }
        Insert: {
          created_at?: string
          feed_key: string
          id?: string
          job_id: string
          pms_family: string
          property_id: string
          screenshot_path: string
        }
        Update: {
          created_at?: string
          feed_key?: string
          id?: string
          job_id?: string
          pms_family?: string
          property_id?: string
          screenshot_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "mapping_feed_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapping_feed_captures_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_help_requests: {
        Row: {
          action_type: string | null
          admin_user_id: string | null
          answered_at: string | null
          created_at: string
          expires_at: string
          id: string
          job_id: string
          question: string
          response_coordinate: Json | null
          response_text: string | null
          screenshot_storage_path: string
          scroll_x: number
          scroll_y: number
          status: string
          suggested_paths: Json | null
          target_key: string
          viewport_h: number
          viewport_w: number
          what_ive_tried: Json | null
        }
        Insert: {
          action_type?: string | null
          admin_user_id?: string | null
          answered_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          job_id: string
          question: string
          response_coordinate?: Json | null
          response_text?: string | null
          screenshot_storage_path: string
          scroll_x?: number
          scroll_y?: number
          status?: string
          suggested_paths?: Json | null
          target_key: string
          viewport_h?: number
          viewport_w?: number
          what_ive_tried?: Json | null
        }
        Update: {
          action_type?: string | null
          admin_user_id?: string | null
          answered_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          job_id?: string
          question?: string
          response_coordinate?: Json | null
          response_text?: string | null
          screenshot_storage_path?: string
          scroll_x?: number
          scroll_y?: number
          status?: string
          suggested_paths?: Json | null
          target_key?: string
          viewport_h?: number
          viewport_w?: number
          what_ive_tried?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "mapping_help_requests_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapping_help_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_notes: {
        Row: {
          consumed_at: string | null
          created_at: string
          id: string
          job_id: string
          note: string
          property_id: string | null
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          id?: string
          job_id: string
          note: string
          property_id?: string | null
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          id?: string
          job_id?: string
          note?: string
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mapping_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapping_notes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mfa_verified_sessions: {
        Row: {
          session_id: string
          user_id: string
          verified_at: string
          verified_from_ip: string | null
          verified_from_ua: string | null
        }
        Insert: {
          session_id: string
          user_id: string
          verified_at?: string
          verified_from_ip?: string | null
          verified_from_ua?: string | null
        }
        Update: {
          session_id?: string
          user_id?: string
          verified_at?: string
          verified_from_ip?: string | null
          verified_from_ua?: string | null
        }
        Relationships: []
      }
      ml_feature_flags: {
        Row: {
          demand_layer_enabled: boolean
          inventory_layer_enabled: boolean
          optimizer_enabled: boolean
          predictions_enabled: boolean
          property_id: string
          shadow_mode_enabled: boolean
          supply_layer_enabled: boolean
          target_completion_prob: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          demand_layer_enabled?: boolean
          inventory_layer_enabled?: boolean
          optimizer_enabled?: boolean
          predictions_enabled?: boolean
          property_id: string
          shadow_mode_enabled?: boolean
          supply_layer_enabled?: boolean
          target_completion_prob?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          demand_layer_enabled?: boolean
          inventory_layer_enabled?: boolean
          optimizer_enabled?: boolean
          predictions_enabled?: boolean
          property_id?: string
          shadow_mode_enabled?: boolean
          supply_layer_enabled?: boolean
          target_completion_prob?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ml_feature_flags_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      model_runs: {
        Row: {
          activated_at: string | null
          algorithm: string
          auto_fill_enabled: boolean
          auto_fill_enabled_at: string | null
          baseline_mae: number | null
          beats_baseline_pct: number | null
          cold_start: boolean
          consecutive_passing_runs: number
          created_at: string
          deactivated_at: string | null
          deactivation_reason: string | null
          feature_set_version: string
          hyperparameters: Json | null
          id: string
          is_active: boolean
          is_cold_start: boolean
          is_shadow: boolean
          item_id: string | null
          layer: string
          model_blob_path: string | null
          model_version: string
          notes: string | null
          posterior_params: Json | null
          property_id: string
          shadow_evaluation_mae: number | null
          shadow_promoted_at: string | null
          shadow_started_at: string | null
          trained_at: string
          training_mae: number | null
          training_row_count: number
          validation_holdout_n: number | null
          validation_mae: number | null
        }
        Insert: {
          activated_at?: string | null
          algorithm: string
          auto_fill_enabled?: boolean
          auto_fill_enabled_at?: string | null
          baseline_mae?: number | null
          beats_baseline_pct?: number | null
          cold_start?: boolean
          consecutive_passing_runs?: number
          created_at?: string
          deactivated_at?: string | null
          deactivation_reason?: string | null
          feature_set_version?: string
          hyperparameters?: Json | null
          id?: string
          is_active?: boolean
          is_cold_start?: boolean
          is_shadow?: boolean
          item_id?: string | null
          layer: string
          model_blob_path?: string | null
          model_version: string
          notes?: string | null
          posterior_params?: Json | null
          property_id: string
          shadow_evaluation_mae?: number | null
          shadow_promoted_at?: string | null
          shadow_started_at?: string | null
          trained_at?: string
          training_mae?: number | null
          training_row_count: number
          validation_holdout_n?: number | null
          validation_mae?: number | null
        }
        Update: {
          activated_at?: string | null
          algorithm?: string
          auto_fill_enabled?: boolean
          auto_fill_enabled_at?: string | null
          baseline_mae?: number | null
          beats_baseline_pct?: number | null
          cold_start?: boolean
          consecutive_passing_runs?: number
          created_at?: string
          deactivated_at?: string | null
          deactivation_reason?: string | null
          feature_set_version?: string
          hyperparameters?: Json | null
          id?: string
          is_active?: boolean
          is_cold_start?: boolean
          is_shadow?: boolean
          item_id?: string | null
          layer?: string
          model_blob_path?: string | null
          model_version?: string
          notes?: string | null
          posterior_params?: Json | null
          property_id?: string
          shadow_evaluation_mae?: number | null
          shadow_promoted_at?: string | null
          shadow_started_at?: string | null
          trained_at?: string
          training_mae?: number | null
          training_row_count?: number
          validation_holdout_n?: number | null
          validation_mae?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "model_runs_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "model_runs_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "model_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      offline_action_replays: {
        Row: {
          action_id: string
          created_at: string
          endpoint: string
          property_id: string
          result_payload: Json
          staff_id: string
        }
        Insert: {
          action_id: string
          created_at?: string
          endpoint: string
          property_id: string
          result_payload?: Json
          staff_id: string
        }
        Update: {
          action_id?: string
          created_at?: string
          endpoint?: string
          property_id?: string
          result_payload?: Json
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offline_action_replays_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          error_detail: Json | null
          force_remap: boolean
          id: string
          pms_type: string
          progress_pct: number
          property_id: string
          recipe_id: string | null
          result: Json | null
          started_at: string | null
          status: string
          step: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          force_remap?: boolean
          id?: string
          pms_type: string
          progress_pct?: number
          property_id: string
          recipe_id?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          force_remap?: boolean
          id?: string
          pms_type?: string
          progress_pct?: number
          property_id?: string
          recipe_id?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      optimizer_results: {
        Row: {
          achieved_completion_probability: number | null
          assignment_plan: Json | null
          completion_probability_curve: Json
          date: string
          id: string
          inputs_snapshot: Json
          monte_carlo_draws: number
          property_id: string
          ran_at: string
          recommended_headcount: number
          sensitivity_analysis: Json | null
          target_completion_probability: number
        }
        Insert: {
          achieved_completion_probability?: number | null
          assignment_plan?: Json | null
          completion_probability_curve: Json
          date: string
          id?: string
          inputs_snapshot: Json
          monte_carlo_draws?: number
          property_id: string
          ran_at?: string
          recommended_headcount: number
          sensitivity_analysis?: Json | null
          target_completion_probability?: number
        }
        Update: {
          achieved_completion_probability?: number | null
          assignment_plan?: Json | null
          completion_probability_curve?: Json
          date?: string
          id?: string
          inputs_snapshot?: Json
          monte_carlo_draws?: number
          property_id?: string
          ran_at?: string
          recommended_headcount?: number
          sensitivity_analysis?: Json | null
          target_completion_probability?: number
        }
        Relationships: [
          {
            foreignKeyName: "optimizer_results_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_access_epochs: {
        Row: {
          organization_id: string
          updated_at: string
          version: number
        }
        Insert: {
          organization_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          organization_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_access_epochs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_access_events: {
        Row: {
          actor_account_id: string | null
          actor_kind: string
          after_state: Json | null
          before_state: Json | null
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string | null
          request_id: string | null
          support_session_id: string | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          actor_account_id?: string | null
          actor_kind?: string
          after_state?: Json | null
          before_state?: Json | null
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          request_id?: string | null
          support_session_id?: string | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          actor_account_id?: string | null
          actor_kind?: string
          after_state?: Json | null
          before_state?: Json | null
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          request_id?: string | null
          support_session_id?: string | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: []
      }
      organization_access_grants: {
        Row: {
          access_profile: string
          created_at: string
          expires_at: string | null
          granted_by_account_id: string | null
          id: string
          membership_id: string
          organization_id: string
          portfolio_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_account_id: string | null
          scope_type: string
          source: string
          starts_at: string
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          access_profile: string
          created_at?: string
          expires_at?: string | null
          granted_by_account_id?: string | null
          id?: string
          membership_id: string
          organization_id: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type: string
          source?: string
          starts_at?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          access_profile?: string
          created_at?: string
          expires_at?: string | null
          granted_by_account_id?: string | null
          id?: string
          membership_id?: string
          organization_id?: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type?: string
          source?: string
          starts_at?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_access_grants_granted_by_account_id_fkey"
            columns: ["granted_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_access_grants_membership_scope_fkey"
            columns: ["membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_grants_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_grants_property_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "organization_access_grants_revoked_by_account_id_fkey"
            columns: ["revoked_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_access_requests: {
        Row: {
          id: string
          membership_id: string
          organization_id: string
          portfolio_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          reason: string
          requested_access_profile: string
          requested_at: string
          resulting_grant_id: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by_account_id: string | null
          scope_type: string
          status: string
          updated_at: string
        }
        Insert: {
          id?: string
          membership_id: string
          organization_id: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          reason: string
          requested_access_profile: string
          requested_at?: string
          resulting_grant_id?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_account_id?: string | null
          scope_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          id?: string
          membership_id?: string
          organization_id?: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          reason?: string
          requested_access_profile?: string
          requested_at?: string
          resulting_grant_id?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_account_id?: string | null
          scope_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_access_requests_membership_scope_fkey"
            columns: ["membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_requests_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_requests_property_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "organization_access_requests_resulting_grant_id_fkey"
            columns: ["resulting_grant_id"]
            isOneToOne: false
            referencedRelation: "organization_access_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_access_requests_reviewed_by_account_id_fkey"
            columns: ["reviewed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by_membership_id: string | null
          access_profile: string
          created_at: string
          email: string
          expires_at: string
          grant_expires_at: string | null
          id: string
          invited_by_account_id: string | null
          job_category: string
          job_title: string | null
          organization_id: string
          portfolio_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          revoked_at: string | null
          revoked_by_account_id: string | null
          scope_type: string
          status: string
          token_hash: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by_membership_id?: string | null
          access_profile: string
          created_at?: string
          email: string
          expires_at: string
          grant_expires_at?: string | null
          id?: string
          invited_by_account_id?: string | null
          job_category?: string
          job_title?: string | null
          organization_id: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type: string
          status?: string
          token_hash: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by_membership_id?: string | null
          access_profile?: string
          created_at?: string
          email?: string
          expires_at?: string
          grant_expires_at?: string | null
          id?: string
          invited_by_account_id?: string | null
          job_category?: string
          job_title?: string | null
          organization_id?: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type?: string
          status?: string
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_accept_membership_scope_fkey"
            columns: ["accepted_by_membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_invitations_invited_by_account_id_fkey"
            columns: ["invited_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_invitations_property_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "organization_invitations_revoked_by_account_id_fkey"
            columns: ["revoked_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          account_id: string
          covered_property_ids: string[] | null
          created_at: string
          created_by_account_id: string | null
          ended_at: string | null
          id: string
          job_category: string
          job_title: string | null
          membership_scope: string | null
          organization_id: string
          starts_at: string
          status: string
          staxis_role: string | null
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          account_id: string
          covered_property_ids?: string[] | null
          created_at?: string
          created_by_account_id?: string | null
          ended_at?: string | null
          id?: string
          job_category?: string
          job_title?: string | null
          membership_scope?: string | null
          organization_id: string
          starts_at?: string
          status?: string
          staxis_role?: string | null
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          account_id?: string
          covered_property_ids?: string[] | null
          created_at?: string
          created_by_account_id?: string | null
          ended_at?: string | null
          id?: string
          job_category?: string
          job_title?: string | null
          membership_scope?: string | null
          organization_id?: string
          starts_at?: string
          status?: string
          staxis_role?: string | null
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_property_relationships: {
        Row: {
          created_at: string
          created_by_account_id: string | null
          ends_at: string | null
          id: string
          is_primary_grouping: boolean
          organization_id: string
          property_id: string
          relationship_type: string
          starts_at: string
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          created_at?: string
          created_by_account_id?: string | null
          ends_at?: string | null
          id?: string
          is_primary_grouping?: boolean
          organization_id: string
          property_id: string
          relationship_type: string
          starts_at?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          created_at?: string
          created_by_account_id?: string | null
          ends_at?: string | null
          id?: string
          is_primary_grouping?: boolean
          organization_id?: string
          property_id?: string
          relationship_type?: string
          starts_at?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_property_relationships_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_property_relationships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_property_relationships_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_property_relationships_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by_account_id: string | null
          id: string
          legacy_property_id: string | null
          name: string
          organization_type: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          legacy_property_id?: string | null
          name: string
          organization_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          legacy_property_id?: string | null
          name?: string
          organization_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_legacy_property_id_fkey"
            columns: ["legacy_property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          carrier: string | null
          created_at: string
          guest_name: string
          guest_notified_at: string | null
          guest_phone: string | null
          id: string
          logged_at: string
          logged_by_account_id: string | null
          notes: string | null
          photo_path: string | null
          picked_up_at: string | null
          picked_up_by_account_id: string | null
          property_id: string
          room_number: string | null
          status: string
          tracking_number: string | null
          updated_at: string
        }
        Insert: {
          carrier?: string | null
          created_at?: string
          guest_name: string
          guest_notified_at?: string | null
          guest_phone?: string | null
          id?: string
          logged_at?: string
          logged_by_account_id?: string | null
          notes?: string | null
          photo_path?: string | null
          picked_up_at?: string | null
          picked_up_by_account_id?: string | null
          property_id: string
          room_number?: string | null
          status?: string
          tracking_number?: string | null
          updated_at?: string
        }
        Update: {
          carrier?: string | null
          created_at?: string
          guest_name?: string
          guest_notified_at?: string | null
          guest_phone?: string | null
          id?: string
          logged_at?: string
          logged_by_account_id?: string | null
          notes?: string | null
          photo_path?: string | null
          picked_up_at?: string | null
          picked_up_by_account_id?: string | null
          property_id?: string
          room_number?: string | null
          status?: string
          tracking_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "packages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      password_signin_proofs: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          used_at: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          used_at?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          used_at?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      payment_history: {
        Row: {
          amount_cents: number
          created_at: string
          description: string | null
          id: string
          paid_on: string
          source: string
          vendor: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          description?: string | null
          id?: string
          paid_on: string
          source?: string
          vendor: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          description?: string | null
          id?: string
          paid_on?: string
          source?: string
          vendor?: string
        }
        Relationships: []
      }
      phone_pairings: {
        Row: {
          account_id: string
          auth_user_id: string
          challenge_expires_at: string | null
          challenge_token_hash: string | null
          claimed_at: string | null
          completed_at: string | null
          completed_device_token_hash: string | null
          completed_session_id: string | null
          completion_expires_at: string | null
          completion_token_hash: string | null
          created_at: string
          desktop_ip: string | null
          desktop_user_agent: string | null
          id: string
          last_send_started_at: string | null
          otp_digest: string | null
          otp_expires_at: string | null
          otp_sent_at: string | null
          otp_verified_at: string | null
          pair_expires_at: string
          pairing_token_hash: string | null
          pending_otp_digest: string | null
          pending_supabase_hashed_token: string | null
          phone_ip: string | null
          phone_user_agent: string | null
          revoked_at: string | null
          send_count: number
          send_reservation_count: number | null
          send_reservation_id: string | null
          send_reservation_started_at: string | null
          supabase_hashed_token: string | null
          verify_attempt_count: number
        }
        Insert: {
          account_id: string
          auth_user_id: string
          challenge_expires_at?: string | null
          challenge_token_hash?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completed_device_token_hash?: string | null
          completed_session_id?: string | null
          completion_expires_at?: string | null
          completion_token_hash?: string | null
          created_at?: string
          desktop_ip?: string | null
          desktop_user_agent?: string | null
          id?: string
          last_send_started_at?: string | null
          otp_digest?: string | null
          otp_expires_at?: string | null
          otp_sent_at?: string | null
          otp_verified_at?: string | null
          pair_expires_at: string
          pairing_token_hash?: string | null
          pending_otp_digest?: string | null
          pending_supabase_hashed_token?: string | null
          phone_ip?: string | null
          phone_user_agent?: string | null
          revoked_at?: string | null
          send_count?: number
          send_reservation_count?: number | null
          send_reservation_id?: string | null
          send_reservation_started_at?: string | null
          supabase_hashed_token?: string | null
          verify_attempt_count?: number
        }
        Update: {
          account_id?: string
          auth_user_id?: string
          challenge_expires_at?: string | null
          challenge_token_hash?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completed_device_token_hash?: string | null
          completed_session_id?: string | null
          completion_expires_at?: string | null
          completion_token_hash?: string | null
          created_at?: string
          desktop_ip?: string | null
          desktop_user_agent?: string | null
          id?: string
          last_send_started_at?: string | null
          otp_digest?: string | null
          otp_expires_at?: string | null
          otp_sent_at?: string | null
          otp_verified_at?: string | null
          pair_expires_at?: string
          pairing_token_hash?: string | null
          pending_otp_digest?: string | null
          pending_supabase_hashed_token?: string | null
          phone_ip?: string | null
          phone_user_agent?: string | null
          revoked_at?: string | null
          send_count?: number
          send_reservation_count?: number | null
          send_reservation_id?: string | null
          send_reservation_started_at?: string | null
          supabase_hashed_token?: string | null
          verify_attempt_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "phone_pairings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_snapshots: {
        Row: {
          arrival_room_numbers: string[] | null
          arrivals: number | null
          checkout_minutes: number | null
          checkout_room_numbers: string[] | null
          checkouts: number | null
          date: string
          ooo: number | null
          ooo_room_numbers: string[] | null
          property_id: string
          pull_type: string | null
          pulled_at: string | null
          recommended_hks: number | null
          rooms: Json | null
          stayover_arrival_day: number | null
          stayover_arrival_room_numbers: string[] | null
          stayover_day1: number | null
          stayover_day1_minutes: number | null
          stayover_day1_room_numbers: string[] | null
          stayover_day2: number | null
          stayover_day2_minutes: number | null
          stayover_day2_room_numbers: string[] | null
          stayover_unknown: number | null
          stayovers: number | null
          total_cleaning_minutes: number | null
          total_rooms: number | null
          vacant_clean: number | null
          vacant_clean_room_numbers: string[] | null
          vacant_dirty: number | null
          vacant_dirty_minutes: number | null
          vacant_dirty_room_numbers: string[] | null
        }
        Insert: {
          arrival_room_numbers?: string[] | null
          arrivals?: number | null
          checkout_minutes?: number | null
          checkout_room_numbers?: string[] | null
          checkouts?: number | null
          date: string
          ooo?: number | null
          ooo_room_numbers?: string[] | null
          property_id: string
          pull_type?: string | null
          pulled_at?: string | null
          recommended_hks?: number | null
          rooms?: Json | null
          stayover_arrival_day?: number | null
          stayover_arrival_room_numbers?: string[] | null
          stayover_day1?: number | null
          stayover_day1_minutes?: number | null
          stayover_day1_room_numbers?: string[] | null
          stayover_day2?: number | null
          stayover_day2_minutes?: number | null
          stayover_day2_room_numbers?: string[] | null
          stayover_unknown?: number | null
          stayovers?: number | null
          total_cleaning_minutes?: number | null
          total_rooms?: number | null
          vacant_clean?: number | null
          vacant_clean_room_numbers?: string[] | null
          vacant_dirty?: number | null
          vacant_dirty_minutes?: number | null
          vacant_dirty_room_numbers?: string[] | null
        }
        Update: {
          arrival_room_numbers?: string[] | null
          arrivals?: number | null
          checkout_minutes?: number | null
          checkout_room_numbers?: string[] | null
          checkouts?: number | null
          date?: string
          ooo?: number | null
          ooo_room_numbers?: string[] | null
          property_id?: string
          pull_type?: string | null
          pulled_at?: string | null
          recommended_hks?: number | null
          rooms?: Json | null
          stayover_arrival_day?: number | null
          stayover_arrival_room_numbers?: string[] | null
          stayover_day1?: number | null
          stayover_day1_minutes?: number | null
          stayover_day1_room_numbers?: string[] | null
          stayover_day2?: number | null
          stayover_day2_minutes?: number | null
          stayover_day2_room_numbers?: string[] | null
          stayover_unknown?: number | null
          stayovers?: number | null
          total_cleaning_minutes?: number | null
          total_rooms?: number | null
          vacant_clean?: number | null
          vacant_clean_room_numbers?: string[] | null
          vacant_dirty?: number | null
          vacant_dirty_minutes?: number | null
          vacant_dirty_room_numbers?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_snapshots_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_activity_log: {
        Row: {
          action: string | null
          captured_at: string
          details: Json | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          pms_user: string | null
          property_id: string
          raw: Json | null
          target: string | null
        }
        Insert: {
          action?: string | null
          captured_at?: string
          details?: Json | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          pms_user?: string | null
          property_id: string
          raw?: Json | null
          target?: string | null
        }
        Update: {
          action?: string | null
          captured_at?: string
          details?: Json | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          pms_user?: string | null
          property_id?: string
          raw?: Json | null
          target?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_activity_log_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_activity_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_auth_codes: {
        Row: {
          code: string
          consumed_at: string | null
          email_to: string
          id: string
          property_id: string
          raw_ref: string | null
          received_at: string
          sender: string | null
          source: string
          subject: string | null
        }
        Insert: {
          code: string
          consumed_at?: string | null
          email_to: string
          id?: string
          property_id: string
          raw_ref?: string | null
          received_at?: string
          sender?: string | null
          source?: string
          subject?: string | null
        }
        Update: {
          code?: string
          consumed_at?: string | null
          email_to?: string
          id?: string
          property_id?: string
          raw_ref?: string | null
          received_at?: string
          sender?: string | null
          source?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_auth_codes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_booking_pace: {
        Row: {
          adr_otb_cents: number | null
          as_of_date: string
          cancellations_to_date: number | null
          created_at: string
          group_rooms_otb: number | null
          id: string
          ingest_run_id: string
          observed_at: string | null
          property_id: string
          raw: Json | null
          revenue_otb_cents: number | null
          rooms_available: number | null
          rooms_otb: number | null
          stay_date: string
          transient_rooms_otb: number | null
        }
        Insert: {
          adr_otb_cents?: number | null
          as_of_date: string
          cancellations_to_date?: number | null
          created_at?: string
          group_rooms_otb?: number | null
          id?: string
          ingest_run_id: string
          observed_at?: string | null
          property_id: string
          raw?: Json | null
          revenue_otb_cents?: number | null
          rooms_available?: number | null
          rooms_otb?: number | null
          stay_date: string
          transient_rooms_otb?: number | null
        }
        Update: {
          adr_otb_cents?: number | null
          as_of_date?: string
          cancellations_to_date?: number | null
          created_at?: string
          group_rooms_otb?: number | null
          id?: string
          ingest_run_id?: string
          observed_at?: string | null
          property_id?: string
          raw?: Json | null
          revenue_otb_cents?: number | null
          rooms_available?: number | null
          rooms_otb?: number | null
          stay_date?: string
          transient_rooms_otb?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_booking_pace_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_booking_pace_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_channel_performance: {
        Row: {
          as_of: string
          average_lead_time_days: number | null
          average_length_of_stay: number | null
          bookings_count: number | null
          business_date: string
          business_date_source: string
          cancellation_rate_pct: number | null
          channel: string
          commission_paid_cents: number | null
          commission_rate_pct: number | null
          created_at: string
          id: string
          ingest_run_id: string
          last_synced_at: string
          property_id: string
          raw: Json | null
          revenue_cents: number | null
          rooms_sold: number | null
        }
        Insert: {
          as_of: string
          average_lead_time_days?: number | null
          average_length_of_stay?: number | null
          bookings_count?: number | null
          business_date: string
          business_date_source: string
          cancellation_rate_pct?: number | null
          channel: string
          commission_paid_cents?: number | null
          commission_rate_pct?: number | null
          created_at?: string
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          property_id: string
          raw?: Json | null
          revenue_cents?: number | null
          rooms_sold?: number | null
        }
        Update: {
          as_of?: string
          average_lead_time_days?: number | null
          average_length_of_stay?: number | null
          bookings_count?: number | null
          business_date?: string
          business_date_source?: string
          cancellation_rate_pct?: number | null
          channel?: string
          commission_paid_cents?: number | null
          commission_rate_pct?: number | null
          created_at?: string
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          property_id?: string
          raw?: Json | null
          revenue_cents?: number | null
          rooms_sold?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_channel_performance_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_channel_performance_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_dimension_values: {
        Row: {
          canonical_code: string | null
          dimension: string
          first_seen_at: string
          id: string
          last_seen_at: string
          pms_family: string | null
          property_id: string
          raw_value: string
          resolved_at: string | null
          resolved_by: string | null
          seen_count: number
          value_norm: string | null
        }
        Insert: {
          canonical_code?: string | null
          dimension: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          pms_family?: string | null
          property_id: string
          raw_value: string
          resolved_at?: string | null
          resolved_by?: string | null
          seen_count?: number
          value_norm?: string | null
        }
        Update: {
          canonical_code?: string | null
          dimension?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          pms_family?: string | null
          property_id?: string
          raw_value?: string
          resolved_at?: string | null
          resolved_by?: string | null
          seen_count?: number
          value_norm?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_dimension_values_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_entity_change_log: {
        Row: {
          after: Json
          before: Json
          changed_at: string
          changed_fields: string[]
          entity_key: string
          id: string
          ingest_run_id: string | null
          property_id: string
          table_name: string
        }
        Insert: {
          after: Json
          before: Json
          changed_at?: string
          changed_fields: string[]
          entity_key: string
          id?: string
          ingest_run_id?: string | null
          property_id: string
          table_name: string
        }
        Update: {
          after?: Json
          before?: Json
          changed_at?: string
          changed_fields?: string[]
          entity_key?: string
          id?: string
          ingest_run_id?: string | null
          property_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_entity_change_log_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_entity_change_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_catalog: {
        Row: {
          created_at: string
          feed_key: string
          label: string
          legacy_target: string | null
          notes: string | null
          required: boolean
          target_table: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          feed_key: string
          label: string
          legacy_target?: string | null
          notes?: string | null
          required?: boolean
          target_table?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          feed_key?: string
          label?: string
          legacy_target?: string | null
          notes?: string | null
          required?: boolean
          target_table?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_catalog_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_feed_expectations: {
        Row: {
          alert_channel: string
          cadence_kind: string
          created_at: string
          enabled: boolean
          expected_at_local: string | null
          expected_every_minutes: number | null
          feed_key: string
          grace_minutes: number
          notes: string | null
          property_id: string
          report_type: string | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          alert_channel?: string
          cadence_kind: string
          created_at?: string
          enabled?: boolean
          expected_at_local?: string | null
          expected_every_minutes?: number | null
          feed_key: string
          grace_minutes?: number
          notes?: string | null
          property_id: string
          report_type?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          alert_channel?: string
          cadence_kind?: string
          created_at?: string
          enabled?: boolean
          expected_at_local?: string | null
          expected_every_minutes?: number | null
          feed_key?: string
          grace_minutes?: number
          notes?: string | null
          property_id?: string
          report_type?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_expectations_feed_key_fkey"
            columns: ["feed_key"]
            isOneToOne: false
            referencedRelation: "pms_feed_catalog"
            referencedColumns: ["feed_key"]
          },
          {
            foreignKeyName: "pms_feed_expectations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_values: {
        Row: {
          captured_at: string
          feed_key: string
          has_error: boolean
          ingest_run_id: string
          last_error: string | null
          last_error_at: string | null
          last_good_at: string | null
          last_synced_at: string
          property_id: string
          values: Json
        }
        Insert: {
          captured_at?: string
          feed_key: string
          has_error?: boolean
          ingest_run_id: string
          last_error?: string | null
          last_error_at?: string | null
          last_good_at?: string | null
          last_synced_at?: string
          property_id: string
          values?: Json
        }
        Update: {
          captured_at?: string
          feed_key?: string
          has_error?: boolean
          ingest_run_id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_good_at?: string | null
          last_synced_at?: string
          property_id?: string
          values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_values_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_feed_values_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_forecast_daily: {
        Row: {
          booking_pace_indicator: string | null
          created_at: string
          forecast_date: string
          id: string
          ingest_run_id: string
          last_synced_at: string
          projected_adr_cents: number | null
          projected_arrivals: number | null
          projected_departures: number | null
          projected_in_house: number | null
          projected_occupancy_pct: number | null
          projected_revenue_cents: number | null
          projected_revpar_cents: number | null
          property_id: string
          raw: Json | null
          snapshot_date: string
          vs_same_day_last_year_pct: number | null
        }
        Insert: {
          booking_pace_indicator?: string | null
          created_at?: string
          forecast_date: string
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          projected_adr_cents?: number | null
          projected_arrivals?: number | null
          projected_departures?: number | null
          projected_in_house?: number | null
          projected_occupancy_pct?: number | null
          projected_revenue_cents?: number | null
          projected_revpar_cents?: number | null
          property_id: string
          raw?: Json | null
          snapshot_date: string
          vs_same_day_last_year_pct?: number | null
        }
        Update: {
          booking_pace_indicator?: string | null
          created_at?: string
          forecast_date?: string
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          projected_adr_cents?: number | null
          projected_arrivals?: number | null
          projected_departures?: number | null
          projected_in_house?: number | null
          projected_occupancy_pct?: number | null
          projected_revenue_cents?: number | null
          projected_revpar_cents?: number | null
          property_id?: string
          raw?: Json | null
          snapshot_date?: string
          vs_same_day_last_year_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_forecast_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_forecast_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_groups_and_blocks: {
        Row: {
          block_end_date: string | null
          block_start_date: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          cutoff_date: string | null
          group_name: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          package_details: Json | null
          pickup_pct: number | null
          pms_group_id: string
          property_id: string
          rate_cents: number | null
          raw: Json | null
          rooms_blocked: number | null
          rooms_picked_up: number | null
          status: string | null
          updated_at: string
        }
        Insert: {
          block_end_date?: string | null
          block_start_date?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          cutoff_date?: string | null
          group_name?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          package_details?: Json | null
          pickup_pct?: number | null
          pms_group_id: string
          property_id: string
          rate_cents?: number | null
          raw?: Json | null
          rooms_blocked?: number | null
          rooms_picked_up?: number | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          block_end_date?: string | null
          block_start_date?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          cutoff_date?: string | null
          group_name?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          package_details?: Json | null
          pickup_pct?: number | null
          pms_group_id?: string
          property_id?: string
          rate_cents?: number | null
          raw?: Json | null
          rooms_blocked?: number | null
          rooms_picked_up?: number | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_groups_and_blocks_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_groups_and_blocks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_guest_balances: {
        Row: {
          balance_cents: number | null
          captured_at: string
          created_at: string
          deposit_cents: number | null
          folio_status: string | null
          guest_name: string | null
          id: string
          ingest_run_id: string
          last_payment_cents: number | null
          last_payment_method: string | null
          pms_folio_id: string
          pms_reservation_id: string | null
          property_id: string
          raw: Json | null
          room_number: string | null
          updated_at: string
        }
        Insert: {
          balance_cents?: number | null
          captured_at?: string
          created_at?: string
          deposit_cents?: number | null
          folio_status?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id: string
          last_payment_cents?: number | null
          last_payment_method?: string | null
          pms_folio_id: string
          pms_reservation_id?: string | null
          property_id: string
          raw?: Json | null
          room_number?: string | null
          updated_at?: string
        }
        Update: {
          balance_cents?: number | null
          captured_at?: string
          created_at?: string
          deposit_cents?: number | null
          folio_status?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id?: string
          last_payment_cents?: number | null
          last_payment_method?: string | null
          pms_folio_id?: string
          pms_reservation_id?: string | null
          property_id?: string
          raw?: Json | null
          room_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_guest_balances_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_guest_balances_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_guests: {
        Row: {
          address: string | null
          anniversary: string | null
          average_stay_length: number | null
          birthday: string | null
          city: string | null
          corporate_affiliation: string | null
          country: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          group_affiliation: string | null
          id: string
          id_number_last4: string | null
          id_type: string | null
          ingest_run_id: string
          last_room_number: string | null
          last_stay_date: string | null
          last_synced_at: string
          lifetime_stays: number | null
          lifetime_value_cents: number | null
          loyalty_member_since: string | null
          loyalty_points: number | null
          loyalty_program: string | null
          loyalty_tier: string | null
          name: string | null
          nationality: string | null
          notes: string | null
          phone: string | null
          pms_guest_id: string
          postal_code: string | null
          preferences: Json | null
          property_id: string
          raw: Json | null
          special_status: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          anniversary?: string | null
          average_stay_length?: number | null
          birthday?: string | null
          city?: string | null
          corporate_affiliation?: string | null
          country?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          group_affiliation?: string | null
          id?: string
          id_number_last4?: string | null
          id_type?: string | null
          ingest_run_id: string
          last_room_number?: string | null
          last_stay_date?: string | null
          last_synced_at?: string
          lifetime_stays?: number | null
          lifetime_value_cents?: number | null
          loyalty_member_since?: string | null
          loyalty_points?: number | null
          loyalty_program?: string | null
          loyalty_tier?: string | null
          name?: string | null
          nationality?: string | null
          notes?: string | null
          phone?: string | null
          pms_guest_id: string
          postal_code?: string | null
          preferences?: Json | null
          property_id: string
          raw?: Json | null
          special_status?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          anniversary?: string | null
          average_stay_length?: number | null
          birthday?: string | null
          city?: string | null
          corporate_affiliation?: string | null
          country?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          group_affiliation?: string | null
          id?: string
          id_number_last4?: string | null
          id_type?: string | null
          ingest_run_id?: string
          last_room_number?: string | null
          last_stay_date?: string | null
          last_synced_at?: string
          lifetime_stays?: number | null
          lifetime_value_cents?: number | null
          loyalty_member_since?: string | null
          loyalty_points?: number | null
          loyalty_program?: string | null
          loyalty_tier?: string | null
          name?: string | null
          nationality?: string | null
          notes?: string | null
          phone?: string | null
          pms_guest_id?: string
          postal_code?: string | null
          preferences?: Json | null
          property_id?: string
          raw?: Json | null
          special_status?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_guests_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_guests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_housekeeping_assignments: {
        Row: {
          cleaning_type: string | null
          created_at: string
          date: string
          dnd_active: boolean | null
          dnd_until: string | null
          early_checkin_approved: boolean | null
          early_checkin_from: string | null
          housekeeper_name: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          late_checkout_approved: boolean | null
          late_checkout_until: string | null
          notes: string | null
          property_id: string
          raw: Json | null
          refused_reason: string | null
          room_number: string
          scheduled_time: string | null
          service_requested: string | null
          updated_at: string
        }
        Insert: {
          cleaning_type?: string | null
          created_at?: string
          date: string
          dnd_active?: boolean | null
          dnd_until?: string | null
          early_checkin_approved?: boolean | null
          early_checkin_from?: string | null
          housekeeper_name?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          late_checkout_approved?: boolean | null
          late_checkout_until?: string | null
          notes?: string | null
          property_id: string
          raw?: Json | null
          refused_reason?: string | null
          room_number: string
          scheduled_time?: string | null
          service_requested?: string | null
          updated_at?: string
        }
        Update: {
          cleaning_type?: string | null
          created_at?: string
          date?: string
          dnd_active?: boolean | null
          dnd_until?: string | null
          early_checkin_approved?: boolean | null
          early_checkin_from?: string | null
          housekeeper_name?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          late_checkout_approved?: boolean | null
          late_checkout_until?: string | null
          notes?: string | null
          property_id?: string
          raw?: Json | null
          refused_reason?: string | null
          room_number?: string
          scheduled_time?: string | null
          service_requested?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_housekeeping_assignments_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_housekeeping_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_inbox_messages: {
        Row: {
          body_html: string | null
          body_text: string | null
          created_at: string
          email_to: string
          from_addr: string | null
          id: string
          inbox_domain: string | null
          kind: string
          message_id: string | null
          property_id: string
          received_at: string
          report_file_id: string | null
          subject: string | null
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          email_to: string
          from_addr?: string | null
          id?: string
          inbox_domain?: string | null
          kind?: string
          message_id?: string | null
          property_id: string
          received_at?: string
          report_file_id?: string | null
          subject?: string | null
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          email_to?: string
          from_addr?: string | null
          id?: string
          inbox_domain?: string | null
          kind?: string
          message_id?: string | null
          property_id?: string
          received_at?: string
          report_file_id?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_inbox_messages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_inbox_messages_report_file_fk"
            columns: ["report_file_id"]
            isOneToOne: false
            referencedRelation: "pms_report_files"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_ingest_anomalies: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          baseline: number | null
          detail: string | null
          detected_at: string
          feed_key: string | null
          id: string
          kind: string
          observed: number | null
          property_id: string
          ratio: number | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          baseline?: number | null
          detail?: string | null
          detected_at?: string
          feed_key?: string | null
          id?: string
          kind: string
          observed?: number | null
          property_id: string
          ratio?: number | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          baseline?: number | null
          detail?: string | null
          detected_at?: string
          feed_key?: string | null
          id?: string
          kind?: string
          observed?: number | null
          property_id?: string
          ratio?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_anomalies_feed_key_fkey"
            columns: ["feed_key"]
            isOneToOne: false
            referencedRelation: "pms_feed_catalog"
            referencedColumns: ["feed_key"]
          },
          {
            foreignKeyName: "pms_ingest_anomalies_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_ingest_quarantine: {
        Row: {
          delivery_id: string | null
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          occurrences: number
          property_id: string
          raw_row: Json
          reason_code: string
          reason_detail: string | null
          report_type: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          row_index: number | null
          status: string
          target_table: string | null
        }
        Insert: {
          delivery_id?: string | null
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          property_id: string
          raw_row: Json
          reason_code: string
          reason_detail?: string | null
          report_type?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          row_index?: number | null
          status?: string
          target_table?: string | null
        }
        Update: {
          delivery_id?: string | null
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          property_id?: string
          raw_row?: Json
          reason_code?: string
          reason_detail?: string | null
          report_type?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          row_index?: number | null
          status?: string
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_quarantine_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_quarantine_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_ingest_runs: {
        Row: {
          attempt_count: number
          diff: Json | null
          error: string | null
          finished_at: string | null
          id: string
          knowledge_file_id: string | null
          mode: string
          parser_name: string
          parser_version: string
          property_id: string
          report_file_id: string | null
          rows_rejected: number
          rows_written: number
          source_captured_at: string
          source_kind: string
          started_at: string
          status: string
        }
        Insert: {
          attempt_count?: number
          diff?: Json | null
          error?: string | null
          finished_at?: string | null
          id?: string
          knowledge_file_id?: string | null
          mode?: string
          parser_name: string
          parser_version: string
          property_id: string
          report_file_id?: string | null
          rows_rejected?: number
          rows_written?: number
          source_captured_at: string
          source_kind: string
          started_at?: string
          status?: string
        }
        Update: {
          attempt_count?: number
          diff?: Json | null
          error?: string | null
          finished_at?: string | null
          id?: string
          knowledge_file_id?: string | null
          mode?: string
          parser_name?: string
          parser_version?: string
          property_id?: string
          report_file_id?: string | null
          rows_rejected?: number
          rows_written?: number
          source_captured_at?: string
          source_kind?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_runs_knowledge_file_id_fkey"
            columns: ["knowledge_file_id"]
            isOneToOne: false
            referencedRelation: "pms_knowledge_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_runs_report_file_id_fkey"
            columns: ["report_file_id"]
            isOneToOne: false
            referencedRelation: "pms_report_files"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_knowledge_files: {
        Row: {
          created_at: string
          created_by: string
          deleted_at: string | null
          deprecated_at: string | null
          disabled_feeds: Json
          display_name: string | null
          id: string
          knowledge: Json
          learned_at: string
          notes: string | null
          pms_family: string
          promoted_to_active_at: string | null
          signature: string | null
          signed_at: string | null
          signed_with_key_id: string | null
          status: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deprecated_at?: string | null
          disabled_feeds?: Json
          display_name?: string | null
          id?: string
          knowledge: Json
          learned_at?: string
          notes?: string | null
          pms_family: string
          promoted_to_active_at?: string | null
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          version: number
        }
        Update: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deprecated_at?: string | null
          disabled_feeds?: Json
          display_name?: string | null
          id?: string
          knowledge?: Json
          learned_at?: string
          notes?: string | null
          pms_family?: string
          promoted_to_active_at?: string | null
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          version?: number
        }
        Relationships: []
      }
      pms_lost_and_found: {
        Row: {
          claimed_at: string | null
          claimed_by_guest: string | null
          created_at: string
          found_at: string | null
          found_by: string | null
          id: string
          ingest_run_id: string
          item_description: string | null
          last_synced_at: string
          location_found: string | null
          notes: string | null
          pms_item_id: string | null
          property_id: string
          raw: Json | null
          room_number: string | null
          shipping_info: Json | null
          status: string | null
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by_guest?: string | null
          created_at?: string
          found_at?: string | null
          found_by?: string | null
          id?: string
          ingest_run_id: string
          item_description?: string | null
          last_synced_at?: string
          location_found?: string | null
          notes?: string | null
          pms_item_id?: string | null
          property_id: string
          raw?: Json | null
          room_number?: string | null
          shipping_info?: Json | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by_guest?: string | null
          created_at?: string
          found_at?: string | null
          found_by?: string | null
          id?: string
          ingest_run_id?: string
          item_description?: string | null
          last_synced_at?: string
          location_found?: string | null
          notes?: string | null
          pms_item_id?: string | null
          property_id?: string
          raw?: Json | null
          room_number?: string | null
          shipping_info?: Json | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_lost_and_found_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_lost_and_found_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_occupancy_observation: {
        Row: {
          arrivals_remaining_today: number | null
          business_date: string
          cancellations_today: number | null
          captured_at: string
          checked_in_today_count: number | null
          checked_out_today_count: number | null
          departures_remaining_today: number | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          no_shows_today: number | null
          observed_at: string
          observed_at_source: string
          property_id: string
          raw: Json | null
          revenue_today_so_far_cents: number | null
          special_needs_guests_in_house: number | null
          total_guests_in_house: number | null
          total_occupied_rooms: number | null
          total_ooo: number | null
          total_vacant_clean: number | null
          total_vacant_dirty: number | null
          vip_guests_in_house: number | null
          walk_ins_today: number | null
        }
        Insert: {
          arrivals_remaining_today?: number | null
          business_date: string
          cancellations_today?: number | null
          captured_at?: string
          checked_in_today_count?: number | null
          checked_out_today_count?: number | null
          departures_remaining_today?: number | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          no_shows_today?: number | null
          observed_at: string
          observed_at_source: string
          property_id: string
          raw?: Json | null
          revenue_today_so_far_cents?: number | null
          special_needs_guests_in_house?: number | null
          total_guests_in_house?: number | null
          total_occupied_rooms?: number | null
          total_ooo?: number | null
          total_vacant_clean?: number | null
          total_vacant_dirty?: number | null
          vip_guests_in_house?: number | null
          walk_ins_today?: number | null
        }
        Update: {
          arrivals_remaining_today?: number | null
          business_date?: string
          cancellations_today?: number | null
          captured_at?: string
          checked_in_today_count?: number | null
          checked_out_today_count?: number | null
          departures_remaining_today?: number | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          no_shows_today?: number | null
          observed_at?: string
          observed_at_source?: string
          property_id?: string
          raw?: Json | null
          revenue_today_so_far_cents?: number | null
          special_needs_guests_in_house?: number | null
          total_guests_in_house?: number | null
          total_occupied_rooms?: number | null
          total_ooo?: number | null
          total_vacant_clean?: number | null
          total_vacant_dirty?: number | null
          vip_guests_in_house?: number | null
          walk_ins_today?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_in_house_snapshot_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_in_house_snapshot_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_payments_daily: {
        Row: {
          as_of: string
          business_date: string
          business_date_source: string
          captured_at: string
          card_collected_cents: number | null
          cash_collected_cents: number | null
          created_at: string
          deposits_collected_cents: number | null
          id: string
          ingest_run_id: string
          property_id: string
          raw: Json | null
          total_collected_cents: number | null
          updated_at: string
        }
        Insert: {
          as_of: string
          business_date: string
          business_date_source: string
          captured_at?: string
          card_collected_cents?: number | null
          cash_collected_cents?: number | null
          created_at?: string
          deposits_collected_cents?: number | null
          id?: string
          ingest_run_id: string
          property_id: string
          raw?: Json | null
          total_collected_cents?: number | null
          updated_at?: string
        }
        Update: {
          as_of?: string
          business_date?: string
          business_date_source?: string
          captured_at?: string
          card_collected_cents?: number | null
          cash_collected_cents?: number | null
          created_at?: string
          deposits_collected_cents?: number | null
          id?: string
          ingest_run_id?: string
          property_id?: string
          raw?: Json | null
          total_collected_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_payments_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_payments_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_rates_and_inventory: {
        Row: {
          as_of: string
          available_rooms: number | null
          captured_at: string
          id: string
          ingest_run_id: string
          last_synced_at: string
          property_id: string
          rate_amount_cents: number | null
          rate_loaded_in_channel_manager: boolean | null
          rate_parity_status: Json | null
          rate_plan: string | null
          raw: Json | null
          room_type: string
          stay_date: string
        }
        Insert: {
          as_of: string
          available_rooms?: number | null
          captured_at?: string
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          property_id: string
          rate_amount_cents?: number | null
          rate_loaded_in_channel_manager?: boolean | null
          rate_parity_status?: Json | null
          rate_plan?: string | null
          raw?: Json | null
          room_type: string
          stay_date: string
        }
        Update: {
          as_of?: string
          available_rooms?: number | null
          captured_at?: string
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          property_id?: string
          rate_amount_cents?: number | null
          rate_loaded_in_channel_manager?: boolean | null
          rate_parity_status?: Json | null
          rate_plan?: string | null
          raw?: Json | null
          room_type?: string
          stay_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_rates_and_inventory_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_rates_and_inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_report_files: {
        Row: {
          business_date: string | null
          byte_size: number
          contains_pan: boolean
          content_sha256: string
          from_addr: string | null
          id: string
          last_error: string | null
          message_id: string
          mime_type: string | null
          original_filename: string | null
          property_id: string
          raw_purged_at: string | null
          received_at: string
          report_kind: string | null
          sender_approved: boolean
          sender_domain: string | null
          source_captured_at: string
          status: string
          storage_path: string | null
          subject: string | null
        }
        Insert: {
          business_date?: string | null
          byte_size: number
          contains_pan?: boolean
          content_sha256: string
          from_addr?: string | null
          id?: string
          last_error?: string | null
          message_id: string
          mime_type?: string | null
          original_filename?: string | null
          property_id: string
          raw_purged_at?: string | null
          received_at?: string
          report_kind?: string | null
          sender_approved?: boolean
          sender_domain?: string | null
          source_captured_at: string
          status?: string
          storage_path?: string | null
          subject?: string | null
        }
        Update: {
          business_date?: string | null
          byte_size?: number
          contains_pan?: boolean
          content_sha256?: string
          from_addr?: string | null
          id?: string
          last_error?: string | null
          message_id?: string
          mime_type?: string | null
          original_filename?: string | null
          property_id?: string
          raw_purged_at?: string | null
          received_at?: string
          report_kind?: string | null
          sender_approved?: boolean
          sender_domain?: string | null
          source_captured_at?: string
          status?: string
          storage_path?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_reports_cache_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_reservations: {
        Row: {
          accessibility_needs: string | null
          adults: number | null
          arrival_date: string | null
          arrival_time: string | null
          booked_at: string | null
          cancellation_fee_cents: number | null
          cancellation_policy: string | null
          cancellation_reason: string | null
          cancelled_date: string | null
          channel_name: string | null
          children: number | null
          corporate_account: string | null
          created_at: string
          currency: string | null
          departure_date: string | null
          departure_time: string | null
          deposit_amount_cents: number | null
          deposit_status: string | null
          dietary_needs: string | null
          first_seen_at: string
          group_block_id: string | null
          guest_name: string | null
          id: string
          infants: number | null
          ingest_run_id: string
          last_synced_at: string
          nights_derived: number | null
          no_show_date: string | null
          notes: string | null
          num_nights: number | null
          package_name: string | null
          payment_method: string | null
          pms_guest_id: string | null
          pms_reservation_id: string
          property_id: string
          rate_per_night_cents: number | null
          raw: Json | null
          room_number: string | null
          room_type: string | null
          source: string | null
          special_requests: string | null
          status: string | null
          status_changed_at: string | null
          total_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          accessibility_needs?: string | null
          adults?: number | null
          arrival_date?: string | null
          arrival_time?: string | null
          booked_at?: string | null
          cancellation_fee_cents?: number | null
          cancellation_policy?: string | null
          cancellation_reason?: string | null
          cancelled_date?: string | null
          channel_name?: string | null
          children?: number | null
          corporate_account?: string | null
          created_at?: string
          currency?: string | null
          departure_date?: string | null
          departure_time?: string | null
          deposit_amount_cents?: number | null
          deposit_status?: string | null
          dietary_needs?: string | null
          first_seen_at?: string
          group_block_id?: string | null
          guest_name?: string | null
          id?: string
          infants?: number | null
          ingest_run_id: string
          last_synced_at?: string
          nights_derived?: number | null
          no_show_date?: string | null
          notes?: string | null
          num_nights?: number | null
          package_name?: string | null
          payment_method?: string | null
          pms_guest_id?: string | null
          pms_reservation_id: string
          property_id: string
          rate_per_night_cents?: number | null
          raw?: Json | null
          room_number?: string | null
          room_type?: string | null
          source?: string | null
          special_requests?: string | null
          status?: string | null
          status_changed_at?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          accessibility_needs?: string | null
          adults?: number | null
          arrival_date?: string | null
          arrival_time?: string | null
          booked_at?: string | null
          cancellation_fee_cents?: number | null
          cancellation_policy?: string | null
          cancellation_reason?: string | null
          cancelled_date?: string | null
          channel_name?: string | null
          children?: number | null
          corporate_account?: string | null
          created_at?: string
          currency?: string | null
          departure_date?: string | null
          departure_time?: string | null
          deposit_amount_cents?: number | null
          deposit_status?: string | null
          dietary_needs?: string | null
          first_seen_at?: string
          group_block_id?: string | null
          guest_name?: string | null
          id?: string
          infants?: number | null
          ingest_run_id?: string
          last_synced_at?: string
          nights_derived?: number | null
          no_show_date?: string | null
          notes?: string | null
          num_nights?: number | null
          package_name?: string | null
          payment_method?: string | null
          pms_guest_id?: string | null
          pms_reservation_id?: string
          property_id?: string
          rate_per_night_cents?: number | null
          raw?: Json | null
          room_number?: string | null
          room_type?: string | null
          source?: string | null
          special_requests?: string | null
          status?: string | null
          status_changed_at?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_reservations_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_reservations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_revenue_daily: {
        Row: {
          adjustments_cents: number | null
          adr_cents: number | null
          ancillary_revenue_cents: number | null
          as_of: string
          available_rooms: number | null
          business_date: string
          business_date_source: string
          channel_commission_breakdown: Json | null
          comps_cents: number | null
          created_at: string
          discounts_cents: number | null
          fnb_revenue_cents: number | null
          goppar_cents: number | null
          gross_operating_profit_cents: number | null
          group_revenue_cents: number | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          occupancy_pct: number | null
          occupied_rooms: number | null
          ooo_rooms: number | null
          ota_commission_paid_cents: number | null
          property_id: string
          raw: Json | null
          refunds_cents: number | null
          revpar_cents: number | null
          rooms_revenue_cents: number | null
          taxes_collected: Json | null
          total_revenue_cents: number | null
          transient_revenue_cents: number | null
          updated_at: string
          walk_in_revenue_cents: number | null
        }
        Insert: {
          adjustments_cents?: number | null
          adr_cents?: number | null
          ancillary_revenue_cents?: number | null
          as_of: string
          available_rooms?: number | null
          business_date: string
          business_date_source: string
          channel_commission_breakdown?: Json | null
          comps_cents?: number | null
          created_at?: string
          discounts_cents?: number | null
          fnb_revenue_cents?: number | null
          goppar_cents?: number | null
          gross_operating_profit_cents?: number | null
          group_revenue_cents?: number | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          occupancy_pct?: number | null
          occupied_rooms?: number | null
          ooo_rooms?: number | null
          ota_commission_paid_cents?: number | null
          property_id: string
          raw?: Json | null
          refunds_cents?: number | null
          revpar_cents?: number | null
          rooms_revenue_cents?: number | null
          taxes_collected?: Json | null
          total_revenue_cents?: number | null
          transient_revenue_cents?: number | null
          updated_at?: string
          walk_in_revenue_cents?: number | null
        }
        Update: {
          adjustments_cents?: number | null
          adr_cents?: number | null
          ancillary_revenue_cents?: number | null
          as_of?: string
          available_rooms?: number | null
          business_date?: string
          business_date_source?: string
          channel_commission_breakdown?: Json | null
          comps_cents?: number | null
          created_at?: string
          discounts_cents?: number | null
          fnb_revenue_cents?: number | null
          goppar_cents?: number | null
          gross_operating_profit_cents?: number | null
          group_revenue_cents?: number | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          occupancy_pct?: number | null
          occupied_rooms?: number | null
          ooo_rooms?: number | null
          ota_commission_paid_cents?: number | null
          property_id?: string
          raw?: Json | null
          refunds_cents?: number | null
          revpar_cents?: number | null
          rooms_revenue_cents?: number | null
          taxes_collected?: Json | null
          total_revenue_cents?: number | null
          transient_revenue_cents?: number | null
          updated_at?: string
          walk_in_revenue_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_revenue_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_revenue_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_room_status_log: {
        Row: {
          changed_at: string
          changed_by: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          property_id: string
          raw: Json | null
          room_number: string
          source: string
          status: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          property_id: string
          raw?: Json | null
          room_number: string
          source?: string
          status: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          property_id?: string
          raw?: Json | null
          room_number?: string
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_room_status_log_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_room_status_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_rooms_inventory: {
        Row: {
          accessible: boolean | null
          adjoining_to: string | null
          amenities: Json | null
          bed_config: string | null
          connecting_to: string | null
          created_at: string
          floor: string | null
          id: string
          ingest_run_id: string
          is_suite: boolean | null
          last_renovated: string | null
          last_synced_at: string
          max_occupancy: number | null
          pet_friendly: boolean | null
          property_id: string
          raw: Json | null
          room_number: string
          room_type: string | null
          smoking_allowed: boolean | null
          square_footage: number | null
          updated_at: string
          view_type: string | null
        }
        Insert: {
          accessible?: boolean | null
          adjoining_to?: string | null
          amenities?: Json | null
          bed_config?: string | null
          connecting_to?: string | null
          created_at?: string
          floor?: string | null
          id?: string
          ingest_run_id: string
          is_suite?: boolean | null
          last_renovated?: string | null
          last_synced_at?: string
          max_occupancy?: number | null
          pet_friendly?: boolean | null
          property_id: string
          raw?: Json | null
          room_number: string
          room_type?: string | null
          smoking_allowed?: boolean | null
          square_footage?: number | null
          updated_at?: string
          view_type?: string | null
        }
        Update: {
          accessible?: boolean | null
          adjoining_to?: string | null
          amenities?: Json | null
          bed_config?: string | null
          connecting_to?: string | null
          created_at?: string
          floor?: string | null
          id?: string
          ingest_run_id?: string
          is_suite?: boolean | null
          last_renovated?: string | null
          last_synced_at?: string
          max_occupancy?: number | null
          pet_friendly?: boolean | null
          property_id?: string
          raw?: Json | null
          room_number?: string
          room_type?: string | null
          smoking_allowed?: boolean | null
          square_footage?: number | null
          updated_at?: string
          view_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_rooms_inventory_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_rooms_inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_sync_echo: {
        Row: {
          property_id: string
          pushed_at: string
          pushed_value: string
          room_number: string
        }
        Insert: {
          property_id: string
          pushed_at?: string
          pushed_value: string
          room_number: string
        }
        Update: {
          property_id?: string
          pushed_at?: string
          pushed_value?: string
          room_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_sync_echo_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_table_schemas: {
        Row: {
          columns: Json
          created_at: string
          natural_key: string[]
          notes: string | null
          reconcile_key_field: string | null
          snapshot_scope_default: string
          table_name: string
          time_grain: string
          updated_at: string
          write_strategy: string
        }
        Insert: {
          columns: Json
          created_at?: string
          natural_key: string[]
          notes?: string | null
          reconcile_key_field?: string | null
          snapshot_scope_default: string
          table_name: string
          time_grain?: string
          updated_at?: string
          write_strategy: string
        }
        Update: {
          columns?: Json
          created_at?: string
          natural_key?: string[]
          notes?: string | null
          reconcile_key_field?: string | null
          snapshot_scope_default?: string
          table_name?: string
          time_grain?: string
          updated_at?: string
          write_strategy?: string
        }
        Relationships: []
      }
      pms_unmapped_columns: {
        Row: {
          column_label: string
          first_seen_at: string
          last_seen_at: string
          occurrences: number
          property_id: string
          report_type: string
          resolved_at: string | null
          resolved_by: string | null
          sample_values: Json
          status: string
          target_table: string | null
        }
        Insert: {
          column_label: string
          first_seen_at?: string
          last_seen_at?: string
          occurrences?: number
          property_id: string
          report_type: string
          resolved_at?: string | null
          resolved_by?: string | null
          sample_values?: Json
          status?: string
          target_table?: string | null
        }
        Update: {
          column_label?: string
          first_seen_at?: string
          last_seen_at?: string
          occurrences?: number
          property_id?: string
          report_type?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sample_values?: Json
          status?: string
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_unmapped_columns_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_unmapped_columns_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_work_orders_v2: {
        Row: {
          actual_cost_cents: number | null
          area: string | null
          assigned_to: string | null
          category: string | null
          completed_at: string | null
          created_at: string
          description: string | null
          estimated_cost_cents: number | null
          eta_back_in_service: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          out_of_order: boolean | null
          parts_needed: string | null
          pms_work_order_id: string
          priority: string | null
          property_id: string
          raw: Json | null
          recurring_room: boolean | null
          reported_at: string | null
          reported_by: string | null
          resolved_at: string | null
          room_number: string | null
          source: string
          started_at: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          actual_cost_cents?: number | null
          area?: string | null
          assigned_to?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          estimated_cost_cents?: number | null
          eta_back_in_service?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          out_of_order?: boolean | null
          parts_needed?: string | null
          pms_work_order_id: string
          priority?: string | null
          property_id: string
          raw?: Json | null
          recurring_room?: boolean | null
          reported_at?: string | null
          reported_by?: string | null
          resolved_at?: string | null
          room_number?: string | null
          source?: string
          started_at?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          actual_cost_cents?: number | null
          area?: string | null
          assigned_to?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          estimated_cost_cents?: number | null
          eta_back_in_service?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          out_of_order?: boolean | null
          parts_needed?: string | null
          pms_work_order_id?: string
          priority?: string | null
          property_id?: string
          raw?: Json | null
          recurring_room?: boolean | null
          reported_at?: string | null
          reported_by?: string | null
          resolved_at?: string | null
          room_number?: string | null
          source?: string
          started_at?: string | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_work_orders_v2_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_work_orders_v2_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_writeback_recipes: {
        Row: {
          action_key: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          pms_family: string
          recipe: Json
          signature: string | null
          signed_at: string | null
          signed_with_key_id: string | null
          status: string
          updated_at: string
          verified_against: string
          version: number
        }
        Insert: {
          action_key: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          pms_family: string
          recipe: Json
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          updated_at?: string
          verified_against?: string
          version: number
        }
        Update: {
          action_key?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          pms_family?: string
          recipe?: Json
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          updated_at?: string
          verified_against?: string
          version?: number
        }
        Relationships: []
      }
      portfolio_conversation_replay_counters: {
        Row: {
          committed_replay_utf8_bytes: number
          committed_turn_count: number
          conversation_id: string
          updated_at: string
        }
        Insert: {
          committed_replay_utf8_bytes?: number
          committed_turn_count?: number
          conversation_id: string
          updated_at?: string
        }
        Update: {
          committed_replay_utf8_bytes?: number
          committed_turn_count?: number
          conversation_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_conversation_replay_counters_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_knowledge_request_artifacts: {
        Row: {
          account_id: string
          artifact_version: string
          authorization_hash: string
          authorized_property_ids: string[]
          conversation_id: string
          created_at: string
          duration_ms: number
          evidence: Json
          finding_versions: Json
          generated_at: string
          id: string
          knowledge_versions: Json
          normalized_question: string
          organization_id: string
          overlay_version: string
          plan: Json
          presentation_version: string
          property_id: string
          query_plan_version: string
          question_hash: string
          rendered_answer_hash: string
          rendered_answer_text: string
          reproduction_input: Json
          scope_hash: string
          scope_receipt_id: string
          selected_claim_ids: string[]
          selected_property_ids: string[]
          source_versions: Json
        }
        Insert: {
          account_id: string
          artifact_version: string
          authorization_hash: string
          authorized_property_ids: string[]
          conversation_id: string
          created_at?: string
          duration_ms: number
          evidence: Json
          finding_versions: Json
          generated_at: string
          id?: string
          knowledge_versions: Json
          normalized_question: string
          organization_id: string
          overlay_version: string
          plan: Json
          presentation_version: string
          property_id: string
          query_plan_version: string
          question_hash: string
          rendered_answer_hash: string
          rendered_answer_text: string
          reproduction_input: Json
          scope_hash: string
          scope_receipt_id: string
          selected_claim_ids: string[]
          selected_property_ids: string[]
          source_versions: Json
        }
        Update: {
          account_id?: string
          artifact_version?: string
          authorization_hash?: string
          authorized_property_ids?: string[]
          conversation_id?: string
          created_at?: string
          duration_ms?: number
          evidence?: Json
          finding_versions?: Json
          generated_at?: string
          id?: string
          knowledge_versions?: Json
          normalized_question?: string
          organization_id?: string
          overlay_version?: string
          plan?: Json
          presentation_version?: string
          property_id?: string
          query_plan_version?: string
          question_hash?: string
          rendered_answer_hash?: string
          rendered_answer_text?: string
          reproduction_input?: Json
          scope_hash?: string
          scope_receipt_id?: string
          selected_claim_ids?: string[]
          selected_property_ids?: string[]
          source_versions?: Json
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_knowledge_request_artifacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_knowledge_request_artifacts_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_knowledge_request_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_knowledge_request_artifacts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_metric_snapshots: {
        Row: {
          business_date: string
          comparison_version: string
          expires_at: string
          fact: Json
          generated_at: string
          id: string
          metric_id: string
          metric_version: string
          property_id: string
          snapshot_key: string
          source_captured_at: string | null
          source_ingest_run_id: string | null
          source_record_id: string | null
        }
        Insert: {
          business_date: string
          comparison_version?: string
          expires_at: string
          fact: Json
          generated_at?: string
          id?: string
          metric_id: string
          metric_version: string
          property_id: string
          snapshot_key: string
          source_captured_at?: string | null
          source_ingest_run_id?: string | null
          source_record_id?: string | null
        }
        Update: {
          business_date?: string
          comparison_version?: string
          expires_at?: string
          fact?: Json
          generated_at?: string
          id?: string
          metric_id?: string
          metric_version?: string
          property_id?: string
          snapshot_key?: string
          source_captured_at?: string | null
          source_ingest_run_id?: string | null
          source_record_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_metric_snapshots_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_metric_snapshots_source_ingest_run_id_fkey"
            columns: ["source_ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_model_request_artifacts: {
        Row: {
          account_id: string
          actual_model_id: string
          actual_model_tier: string
          applied_parameters: Json
          artifact_version: string
          authorization_hash: string
          authorized_property_ids: string[] | null
          configured_execution: Json
          conversation_id: string | null
          created_at: string
          finding_versions: Json | null
          id: string
          model_candidate_hash: string
          model_candidate_text: string
          normalized_question: string
          organization_id: string
          presentation_plan: Json | null
          presentation_plan_version: string | null
          prompt_hash: string
          prompt_version: string
          property_id: string
          provider_request: Json
          provider_request_hash: string
          question_hash: string
          rendered_answer_hash: string | null
          rendered_answer_text: string | null
          renderer_version: string
          scope_hash: string
          scope_receipt_id: string
          selected_property_ids: string[] | null
        }
        Insert: {
          account_id: string
          actual_model_id: string
          actual_model_tier: string
          applied_parameters: Json
          artifact_version: string
          authorization_hash: string
          authorized_property_ids?: string[] | null
          configured_execution: Json
          conversation_id?: string | null
          created_at?: string
          finding_versions?: Json | null
          id?: string
          model_candidate_hash: string
          model_candidate_text: string
          normalized_question: string
          organization_id: string
          presentation_plan?: Json | null
          presentation_plan_version?: string | null
          prompt_hash: string
          prompt_version: string
          property_id: string
          provider_request: Json
          provider_request_hash: string
          question_hash: string
          rendered_answer_hash?: string | null
          rendered_answer_text?: string | null
          renderer_version: string
          scope_hash: string
          scope_receipt_id: string
          selected_property_ids?: string[] | null
        }
        Update: {
          account_id?: string
          actual_model_id?: string
          actual_model_tier?: string
          applied_parameters?: Json
          artifact_version?: string
          authorization_hash?: string
          authorized_property_ids?: string[] | null
          configured_execution?: Json
          conversation_id?: string | null
          created_at?: string
          finding_versions?: Json | null
          id?: string
          model_candidate_hash?: string
          model_candidate_text?: string
          normalized_question?: string
          organization_id?: string
          presentation_plan?: Json | null
          presentation_plan_version?: string | null
          prompt_hash?: string
          prompt_version?: string
          property_id?: string
          provider_request?: Json
          provider_request_hash?: string
          question_hash?: string
          rendered_answer_hash?: string | null
          rendered_answer_text?: string | null
          renderer_version?: string
          scope_hash?: string
          scope_receipt_id?: string
          selected_property_ids?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_model_request_artifacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_model_request_artifacts_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_model_request_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_model_request_artifacts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_properties: {
        Row: {
          assigned_at: string
          assigned_by_account_id: string | null
          created_at: string
          id: string
          organization_id: string
          portfolio_id: string
          property_id: string
          property_relationship_id: string
          removed_at: string | null
          removed_by_account_id: string | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by_account_id?: string | null
          created_at?: string
          id?: string
          organization_id: string
          portfolio_id: string
          property_id: string
          property_relationship_id: string
          removed_at?: string | null
          removed_by_account_id?: string | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by_account_id?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          portfolio_id?: string
          property_id?: string
          property_relationship_id?: string
          removed_at?: string | null
          removed_by_account_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_properties_assigned_by_account_id_fkey"
            columns: ["assigned_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_properties_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "portfolio_properties_relationship_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "portfolio_properties_removed_by_account_id_fkey"
            columns: ["removed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_query_admissions: {
        Row: {
          account_id: string
          hour_bucket: string
          hour_count: number
          lease_expires_at: string | null
          lease_token: string | null
          minute_bucket: string
          minute_count: number
          organization_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          hour_bucket: string
          hour_count?: number
          lease_expires_at?: string | null
          lease_token?: string | null
          minute_bucket: string
          minute_count?: number
          organization_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          hour_bucket?: string
          hour_count?: number
          lease_expires_at?: string | null
          lease_token?: string | null
          minute_bucket?: string
          minute_count?: number
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_query_admissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_admissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_query_receipts: {
        Row: {
          account_id: string
          answer_hash: string | null
          authorization_hash: string
          authorized_property_ids: string[]
          conversation_id: string | null
          duration_ms: number
          evidence: Json
          evidence_version: string
          finding_binding_status: string
          finding_versions: Json
          generated_at: string
          id: string
          knowledge_artifact_id: string | null
          knowledge_versions: Json
          metric_versions: Json
          model_candidate_hash: string | null
          model_id: string | null
          model_tier: string | null
          organization_id: string
          plan: Json
          presentation_plan_version: string | null
          prompt_hash: string | null
          prompt_version: string
          property_id: string
          query_plan_version: string
          question_hash: string
          receipt_kind: string
          renderer_version: string | null
          request_artifact_id: string | null
          scope_hash: string
          scope_receipt_id: string
          selected_property_ids: string[]
          source_versions: Json
          status: string
        }
        Insert: {
          account_id: string
          answer_hash?: string | null
          authorization_hash: string
          authorized_property_ids: string[]
          conversation_id?: string | null
          duration_ms: number
          evidence: Json
          evidence_version: string
          finding_binding_status?: string
          finding_versions?: Json
          generated_at?: string
          id?: string
          knowledge_artifact_id?: string | null
          knowledge_versions?: Json
          metric_versions: Json
          model_candidate_hash?: string | null
          model_id?: string | null
          model_tier?: string | null
          organization_id: string
          plan: Json
          presentation_plan_version?: string | null
          prompt_hash?: string | null
          prompt_version: string
          property_id: string
          query_plan_version: string
          question_hash: string
          receipt_kind?: string
          renderer_version?: string | null
          request_artifact_id?: string | null
          scope_hash: string
          scope_receipt_id: string
          selected_property_ids: string[]
          source_versions: Json
          status: string
        }
        Update: {
          account_id?: string
          answer_hash?: string | null
          authorization_hash?: string
          authorized_property_ids?: string[]
          conversation_id?: string | null
          duration_ms?: number
          evidence?: Json
          evidence_version?: string
          finding_binding_status?: string
          finding_versions?: Json
          generated_at?: string
          id?: string
          knowledge_artifact_id?: string | null
          knowledge_versions?: Json
          metric_versions?: Json
          model_candidate_hash?: string | null
          model_id?: string | null
          model_tier?: string | null
          organization_id?: string
          plan?: Json
          presentation_plan_version?: string | null
          prompt_hash?: string | null
          prompt_version?: string
          property_id?: string
          query_plan_version?: string
          question_hash?: string
          receipt_kind?: string
          renderer_version?: string | null
          request_artifact_id?: string | null
          scope_hash?: string
          scope_receipt_id?: string
          selected_property_ids?: string[]
          source_versions?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_query_receipts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_receipts_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_receipts_knowledge_artifact_id_fkey"
            columns: ["knowledge_artifact_id"]
            isOneToOne: false
            referencedRelation: "portfolio_knowledge_request_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_receipts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_receipts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_receipts_request_artifact_id_fkey"
            columns: ["request_artifact_id"]
            isOneToOne: false
            referencedRelation: "portfolio_model_request_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_query_turn_commits: {
        Row: {
          assistant_message_id: string
          committed_at: string
          conversation_id: string
          query_receipt_id: string
          replay_utf8_bytes: number
          user_message_id: string
        }
        Insert: {
          assistant_message_id: string
          committed_at?: string
          conversation_id: string
          query_receipt_id: string
          replay_utf8_bytes: number
          user_message_id: string
        }
        Update: {
          assistant_message_id?: string
          committed_at?: string
          conversation_id?: string
          query_receipt_id?: string
          replay_utf8_bytes?: number
          user_message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_query_turn_commits_assistant_message_id_fkey"
            columns: ["assistant_message_id"]
            isOneToOne: true
            referencedRelation: "agent_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_turn_commits_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_turn_commits_query_receipt_id_fkey"
            columns: ["query_receipt_id"]
            isOneToOne: true
            referencedRelation: "portfolio_query_receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_query_turn_commits_user_message_id_fkey"
            columns: ["user_message_id"]
            isOneToOne: true
            referencedRelation: "agent_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolios: {
        Row: {
          created_at: string
          created_by_account_id: string | null
          id: string
          name: string
          organization_id: string
          parent_id: string | null
          portfolio_type: string
          status: string
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          name: string
          organization_id: string
          parent_id?: string | null
          portfolio_type?: string
          status?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          name?: string
          organization_id?: string
          parent_id?: string | null
          portfolio_type?: string
          status?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolios_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolios_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolios_parent_same_organization_fkey"
            columns: ["parent_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "portfolios_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_log: {
        Row: {
          abs_error: number | null
          actual_value: number
          cleaning_event_id: string | null
          date: string
          id: string
          inventory_count_id: string | null
          layer: string
          logged_at: string
          model_run_id: string
          pinball_loss_p50: number | null
          predicted_value: number
          prediction_id: string
          property_id: string
          squared_error: number | null
        }
        Insert: {
          abs_error?: number | null
          actual_value: number
          cleaning_event_id?: string | null
          date: string
          id?: string
          inventory_count_id?: string | null
          layer: string
          logged_at?: string
          model_run_id: string
          pinball_loss_p50?: number | null
          predicted_value: number
          prediction_id: string
          property_id: string
          squared_error?: number | null
        }
        Update: {
          abs_error?: number | null
          actual_value?: number
          cleaning_event_id?: string | null
          date?: string
          id?: string
          inventory_count_id?: string | null
          layer?: string
          logged_at?: string
          model_run_id?: string
          pinball_loss_p50?: number | null
          predicted_value?: number
          prediction_id?: string
          property_id?: string
          squared_error?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_log_cleaning_event_id_fkey"
            columns: ["cleaning_event_id"]
            isOneToOne: false
            referencedRelation: "cleaning_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_log_inventory_count_property_fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "prediction_log_inventory_count_property_fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_observed_rate_v"
            referencedColumns: ["newer_count_id", "property_id"]
          },
          {
            foreignKeyName: "prediction_log_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_overrides: {
        Row: {
          date: string
          id: string
          manual_headcount: number
          optimizer_recommendation: number
          optimizer_results_id: string | null
          outcome_actual_minutes_worked: number | null
          outcome_completed_on_time: boolean | null
          outcome_overtime_minutes: number | null
          outcome_recorded_at: string | null
          override_at: string
          override_by: string | null
          override_reason: string | null
          property_id: string
        }
        Insert: {
          date: string
          id?: string
          manual_headcount: number
          optimizer_recommendation: number
          optimizer_results_id?: string | null
          outcome_actual_minutes_worked?: number | null
          outcome_completed_on_time?: boolean | null
          outcome_overtime_minutes?: number | null
          outcome_recorded_at?: string | null
          override_at?: string
          override_by?: string | null
          override_reason?: string | null
          property_id: string
        }
        Update: {
          date?: string
          id?: string
          manual_headcount?: number
          optimizer_recommendation?: number
          optimizer_results_id?: string | null
          outcome_actual_minutes_worked?: number | null
          outcome_completed_on_time?: boolean | null
          outcome_overtime_minutes?: number | null
          outcome_recorded_at?: string | null
          override_at?: string
          override_by?: string | null
          override_reason?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_overrides_optimizer_results_id_fkey"
            columns: ["optimizer_results_id"]
            isOneToOne: false
            referencedRelation: "optimizer_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_overrides_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      preventive_tasks: {
        Row: {
          area: string | null
          called_at: string | null
          called_by: string | null
          completion_photo_path: string | null
          created_at: string
          equipment_id: string | null
          frequency_days: number
          id: string
          last_completed_at: string | null
          last_completed_by: string | null
          name: string
          notes: string | null
          property_id: string
        }
        Insert: {
          area?: string | null
          called_at?: string | null
          called_by?: string | null
          completion_photo_path?: string | null
          created_at?: string
          equipment_id?: string | null
          frequency_days: number
          id?: string
          last_completed_at?: string | null
          last_completed_by?: string | null
          name: string
          notes?: string | null
          property_id: string
        }
        Update: {
          area?: string | null
          called_at?: string | null
          called_by?: string | null
          completion_photo_path?: string | null
          created_at?: string
          equipment_id?: string | null
          frequency_days?: number
          id?: string
          last_completed_at?: string | null
          last_completed_by?: string | null
          name?: string
          notes?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "preventive_tasks_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preventive_tasks_equipment_same_property_fk"
            columns: ["property_id", "equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["property_id", "id"]
          },
          {
            foreignKeyName: "preventive_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_sentry_webhooks: {
        Row: {
          event_id: string
          metadata: Json
          processed_at: string
          webhook_kind: string
        }
        Insert: {
          event_id: string
          metadata?: Json
          processed_at?: string
          webhook_kind: string
        }
        Update: {
          event_id?: string
          metadata?: Json
          processed_at?: string
          webhook_kind?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          alert_phone: string | null
          avg_occupancy: number
          brand: string | null
          business_date_cutoff_hour: number
          checkout_minutes: number
          climate_zone: string | null
          compliance_anomaly_sms_enabled: boolean
          created_at: string
          dashboard_stale_minutes: number
          enabled_sections: Json | null
          evening_forecast_time: string | null
          financials_alerts_sms_enabled: boolean
          hourly_wage: number
          housekeeping_setup: Json | null
          id: string
          inventory_ai_mode: string
          inventory_budget_mode: string
          inventory_tab_layout: Json | null
          is_test: boolean
          last_synced_at: string | null
          morning_briefing_time: string | null
          name: string
          nudge_subscription: Json | null
          onboarding_completed_at: string | null
          onboarding_prompt_shown_at: string | null
          onboarding_source: string
          onboarding_state: Json
          ordering_intro_dismissed_at: string | null
          ordering_mode: string
          owner_id: string
          pms_connected: boolean | null
          pms_type: string | null
          pms_url: string | null
          pms_writeback_actions: string[]
          pms_writeback_enabled: boolean
          prep_minutes_per_activity: number
          property_kind: string
          region: string | null
          room_inventory: string[]
          scraper_window_end_hour: number
          scraper_window_start_hour: number
          services_enabled: Json
          shift_minutes: number
          size_tier: string | null
          stayover_day1_minutes: number | null
          stayover_day2_minutes: number | null
          stayover_minutes: number
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string
          timezone: string
          total_rooms: number
          total_staff_on_roster: number
          trial_ends_at: string | null
          updated_at: string
          weekly_budget: number | null
        }
        Insert: {
          alert_phone?: string | null
          avg_occupancy?: number
          brand?: string | null
          business_date_cutoff_hour?: number
          checkout_minutes?: number
          climate_zone?: string | null
          compliance_anomaly_sms_enabled?: boolean
          created_at?: string
          dashboard_stale_minutes?: number
          enabled_sections?: Json | null
          evening_forecast_time?: string | null
          financials_alerts_sms_enabled?: boolean
          hourly_wage?: number
          housekeeping_setup?: Json | null
          id?: string
          inventory_ai_mode?: string
          inventory_budget_mode?: string
          inventory_tab_layout?: Json | null
          is_test?: boolean
          last_synced_at?: string | null
          morning_briefing_time?: string | null
          name: string
          nudge_subscription?: Json | null
          onboarding_completed_at?: string | null
          onboarding_prompt_shown_at?: string | null
          onboarding_source?: string
          onboarding_state?: Json
          ordering_intro_dismissed_at?: string | null
          ordering_mode?: string
          owner_id: string
          pms_connected?: boolean | null
          pms_type?: string | null
          pms_url?: string | null
          pms_writeback_actions?: string[]
          pms_writeback_enabled?: boolean
          prep_minutes_per_activity?: number
          property_kind?: string
          region?: string | null
          room_inventory?: string[]
          scraper_window_end_hour?: number
          scraper_window_start_hour?: number
          services_enabled?: Json
          shift_minutes?: number
          size_tier?: string | null
          stayover_day1_minutes?: number | null
          stayover_day2_minutes?: number | null
          stayover_minutes?: number
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          timezone?: string
          total_rooms: number
          total_staff_on_roster?: number
          trial_ends_at?: string | null
          updated_at?: string
          weekly_budget?: number | null
        }
        Update: {
          alert_phone?: string | null
          avg_occupancy?: number
          brand?: string | null
          business_date_cutoff_hour?: number
          checkout_minutes?: number
          climate_zone?: string | null
          compliance_anomaly_sms_enabled?: boolean
          created_at?: string
          dashboard_stale_minutes?: number
          enabled_sections?: Json | null
          evening_forecast_time?: string | null
          financials_alerts_sms_enabled?: boolean
          hourly_wage?: number
          housekeeping_setup?: Json | null
          id?: string
          inventory_ai_mode?: string
          inventory_budget_mode?: string
          inventory_tab_layout?: Json | null
          is_test?: boolean
          last_synced_at?: string | null
          morning_briefing_time?: string | null
          name?: string
          nudge_subscription?: Json | null
          onboarding_completed_at?: string | null
          onboarding_prompt_shown_at?: string | null
          onboarding_source?: string
          onboarding_state?: Json
          ordering_intro_dismissed_at?: string | null
          ordering_mode?: string
          owner_id?: string
          pms_connected?: boolean | null
          pms_type?: string | null
          pms_url?: string | null
          pms_writeback_actions?: string[]
          pms_writeback_enabled?: boolean
          prep_minutes_per_activity?: number
          property_kind?: string
          region?: string | null
          room_inventory?: string[]
          scraper_window_end_hour?: number
          scraper_window_start_hour?: number
          services_enabled?: Json
          shift_minutes?: number
          size_tier?: string | null
          stayover_day1_minutes?: number | null
          stayover_day2_minutes?: number | null
          stayover_minutes?: number
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          timezone?: string
          total_rooms?: number
          total_staff_on_roster?: number
          trial_ends_at?: string | null
          updated_at?: string
          weekly_budget?: number | null
        }
        Relationships: []
      }
      property_sessions: {
        Row: {
          created_at: string
          current_browser_url: string | null
          daily_claude_cost_micros: number
          daily_claude_cost_resets_at: string
          last_alive_at: string | null
          last_successful_read_at: string | null
          notes: string | null
          paused_reason: string | null
          paused_until: string | null
          pms_family: string
          property_id: string
          read_failure_streak: number
          restart_count: number
          status: string
          updated_at: string
          worker_machine_id: string | null
        }
        Insert: {
          created_at?: string
          current_browser_url?: string | null
          daily_claude_cost_micros?: number
          daily_claude_cost_resets_at?: string
          last_alive_at?: string | null
          last_successful_read_at?: string | null
          notes?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          pms_family: string
          property_id: string
          read_failure_streak?: number
          restart_count?: number
          status?: string
          updated_at?: string
          worker_machine_id?: string | null
        }
        Update: {
          created_at?: string
          current_browser_url?: string | null
          daily_claude_cost_micros?: number
          daily_claude_cost_resets_at?: string
          last_alive_at?: string | null
          last_successful_read_at?: string | null
          notes?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          pms_family?: string
          property_id?: string
          read_failure_streak?: number
          restart_count?: number
          status?: string
          updated_at?: string
          worker_machine_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_sessions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_shift_presets: {
        Row: {
          created_at: string
          department: string
          end_time: string
          id: string
          name: string
          property_id: string
          sort_order: number
          start_time: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department: string
          end_time: string
          id?: string
          name: string
          property_id: string
          sort_order?: number
          start_time: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string
          end_time?: string
          id?: string
          name?: string
          property_id?: string
          sort_order?: number
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_shift_presets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      prospects: {
        Row: {
          checklist: Json
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          expected_launch_date: string | null
          hotel_name: string
          id: string
          notes: string | null
          pms_type: string | null
          status: string
          updated_at: string
        }
        Insert: {
          checklist?: Json
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          expected_launch_date?: string | null
          hotel_name: string
          id?: string
          notes?: string | null
          pms_type?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          checklist?: Json
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          expected_launch_date?: string | null
          hotel_name?: string
          id?: string
          notes?: string | null
          pms_type?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      public_areas: {
        Row: {
          created_at: string
          floor: string
          frequency_days: number
          id: string
          is_rented_today: boolean | null
          locations: number
          minutes_per_clean: number
          name: string
          only_when_rented: boolean | null
          property_id: string
          start_date: string
        }
        Insert: {
          created_at?: string
          floor: string
          frequency_days: number
          id?: string
          is_rented_today?: boolean | null
          locations?: number
          minutes_per_clean: number
          name: string
          only_when_rented?: boolean | null
          property_id: string
          start_date: string
        }
        Update: {
          created_at?: string
          floor?: string
          frequency_days?: number
          id?: string
          is_rented_today?: boolean | null
          locations?: number
          minutes_per_clean?: number
          name?: string
          only_when_rented?: boolean | null
          property_id?: string
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_areas_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pull_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          error_detail: Json | null
          id: string
          pms_type: string
          progress_pct: number
          property_id: string
          recipe_id: string | null
          result: Json | null
          scheduled_for: string
          started_at: string | null
          status: string
          step: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          id?: string
          pms_type: string
          progress_pct?: number
          property_id: string
          recipe_id?: string | null
          result?: Json | null
          scheduled_for?: string
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          id?: string
          pms_type?: string
          progress_pct?: number
          property_id?: string
          recipe_id?: string | null
          result?: Json | null
          scheduled_for?: string
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pull_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          item_id: string | null
          purchase_order_id: string
          qty_ordered: number
          qty_received: number
          unit_cost_cents: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          item_id?: string | null
          purchase_order_id: string
          qty_ordered: number
          qty_received?: number
          unit_cost_cents?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          item_id?: string | null
          purchase_order_id?: string
          qty_ordered?: number
          qty_received?: number
          unit_cost_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          id: string
          notes: string | null
          placed_via: string | null
          po_number: string
          property_id: string
          received_at: string | null
          sent_at: string | null
          sent_to_email: string | null
          status: string
          subtotal_cents: number
          updated_at: string
          vendor_id: string | null
          vendor_name_snapshot: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          notes?: string | null
          placed_via?: string | null
          po_number: string
          property_id: string
          received_at?: string | null
          sent_at?: string | null
          sent_to_email?: string | null
          status?: string
          subtotal_cents?: number
          updated_at?: string
          vendor_id?: string | null
          vendor_name_snapshot?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          notes?: string | null
          placed_via?: string | null
          po_number?: string
          property_id?: string
          received_at?: string | null
          sent_at?: string | null
          sent_to_email?: string | null
          status?: string
          subtotal_cents?: number
          updated_at?: string
          vendor_id?: string | null
          vendor_name_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_task_templates: {
        Row: {
          active: boolean
          assigned_department: string | null
          assigned_staff_id: string | null
          cadence: string
          created_at: string
          created_by_staff_id: string | null
          id: string
          last_spawned_on: string | null
          priority: string
          property_id: string
          title: string
          updated_at: string
          weekday: number | null
        }
        Insert: {
          active?: boolean
          assigned_department?: string | null
          assigned_staff_id?: string | null
          cadence: string
          created_at?: string
          created_by_staff_id?: string | null
          id?: string
          last_spawned_on?: string | null
          priority?: string
          property_id: string
          title: string
          updated_at?: string
          weekday?: number | null
        }
        Update: {
          active?: boolean
          assigned_department?: string | null
          assigned_staff_id?: string | null
          cadence?: string
          created_at?: string
          created_by_staff_id?: string | null
          id?: string
          last_spawned_on?: string | null
          priority?: string
          property_id?: string
          title?: string
          updated_at?: string
          weekday?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recurring_task_templates_assigned_staff_id_fkey"
            columns: ["assigned_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_task_templates_created_by_staff_id_fkey"
            columns: ["created_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_task_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_favorites: {
        Row: {
          account_id: string
          created_at: string
          id: string
          property_id: string
          report_key: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          property_id: string
          report_key: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          property_id?: string
          report_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_favorites_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_favorites_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_preferences: {
        Row: {
          account_id: string
          cc_emails: Json
          channels: Json
          created_at: string
          delivery_time_local: string
          id: string
          paused_until: string | null
          property_id: string
          updated_at: string
          weekly_enabled: boolean
        }
        Insert: {
          account_id: string
          cc_emails?: Json
          channels?: Json
          created_at?: string
          delivery_time_local?: string
          id?: string
          paused_until?: string | null
          property_id: string
          updated_at?: string
          weekly_enabled?: boolean
        }
        Update: {
          account_id?: string
          cc_emails?: Json
          channels?: Json
          created_at?: string
          delivery_time_local?: string
          id?: string
          paused_until?: string | null
          property_id?: string
          updated_at?: string
          weekly_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "report_preferences_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_preferences_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_runs: {
        Row: {
          created_at: string
          email_send_status: Json
          generated_at: string
          id: string
          insight_text: string | null
          property_id: string
          recipients: Json
          report_date: string
          report_payload: Json | null
          report_type: string
        }
        Insert: {
          created_at?: string
          email_send_status?: Json
          generated_at?: string
          id?: string
          insight_text?: string | null
          property_id: string
          recipients?: Json
          report_date: string
          report_payload?: Json | null
          report_type: string
        }
        Update: {
          created_at?: string
          email_send_status?: Json
          generated_at?: string
          id?: string
          insight_text?: string | null
          property_id?: string
          recipients?: Json
          report_date?: string
          report_payload?: Json | null
          report_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_schedules: {
        Row: {
          cadence: string
          created_at: string
          created_by_account_id: string | null
          day_of_month: number | null
          day_of_week: number | null
          enabled: boolean
          hour_local: number
          id: string
          last_run_date: string | null
          last_run_status: string | null
          property_id: string
          range_kind: string
          recipients: Json
          report_key: string
          updated_at: string
        }
        Insert: {
          cadence: string
          created_at?: string
          created_by_account_id?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          hour_local?: number
          id?: string
          last_run_date?: string | null
          last_run_status?: string | null
          property_id: string
          range_kind?: string
          recipients?: Json
          report_key: string
          updated_at?: string
        }
        Update: {
          cadence?: string
          created_at?: string
          created_by_account_id?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          hour_local?: number
          id?: string
          last_run_date?: string | null
          last_run_status?: string | null
          property_id?: string
          range_kind?: string
          recipients?: Json
          report_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_schedules_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_schedules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      roadmap_items: {
        Row: {
          created_at: string
          description: string | null
          done_at: string | null
          id: string
          priority: number
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          done_at?: string | null
          id?: string
          priority?: number
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          done_at?: string | null
          id?: string
          priority?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      role_changes: {
        Row: {
          account_id: string
          change_kind: string
          changed_at: string
          changed_by_account_id: string | null
          id: string
          new_role: string
          old_role: string | null
          property_id: string
          reason: string | null
        }
        Insert: {
          account_id: string
          change_kind?: string
          changed_at?: string
          changed_by_account_id?: string | null
          id?: string
          new_role: string
          old_role?: string | null
          property_id: string
          reason?: string | null
        }
        Update: {
          account_id?: string
          change_kind?: string
          changed_at?: string
          changed_by_account_id?: string | null
          id?: string
          new_role?: string
          old_role?: string | null
          property_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "role_changes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_changes_changed_by_account_id_fkey"
            columns: ["changed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_changes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      room_work: {
        Row: {
          assigned_source: string | null
          assigned_staff_id: string | null
          checklist_progress: string[]
          checklist_template_id: string | null
          completed_at: string | null
          created_at: string
          date: string
          dnd_active: boolean | null
          dnd_note: string | null
          exception_at: string | null
          exception_note: string | null
          exception_type: string | null
          help_requested: boolean
          housekeeper_note: string | null
          housekeeper_note_at: string | null
          inspected_at: string | null
          inspected_by: string | null
          is_paused: boolean
          is_rush: boolean
          issue_note: string | null
          manager_notes: string | null
          manager_notes_at: string | null
          manager_notes_by_account_id: string | null
          marked_for_inspection_at: string | null
          paused_at: string | null
          property_id: string
          room_number: string
          rush_due_by: string | null
          rush_duration_label: string | null
          rush_requested_by_account_id: string | null
          rush_set_at: string | null
          rush_set_by: string | null
          started_at: string | null
          status: string | null
          time_spent_minutes: number | null
          total_paused_seconds: number
          updated_at: string
        }
        Insert: {
          assigned_source?: string | null
          assigned_staff_id?: string | null
          checklist_progress?: string[]
          checklist_template_id?: string | null
          completed_at?: string | null
          created_at?: string
          date: string
          dnd_active?: boolean | null
          dnd_note?: string | null
          exception_at?: string | null
          exception_note?: string | null
          exception_type?: string | null
          help_requested?: boolean
          housekeeper_note?: string | null
          housekeeper_note_at?: string | null
          inspected_at?: string | null
          inspected_by?: string | null
          is_paused?: boolean
          is_rush?: boolean
          issue_note?: string | null
          manager_notes?: string | null
          manager_notes_at?: string | null
          manager_notes_by_account_id?: string | null
          marked_for_inspection_at?: string | null
          paused_at?: string | null
          property_id: string
          room_number: string
          rush_due_by?: string | null
          rush_duration_label?: string | null
          rush_requested_by_account_id?: string | null
          rush_set_at?: string | null
          rush_set_by?: string | null
          started_at?: string | null
          status?: string | null
          time_spent_minutes?: number | null
          total_paused_seconds?: number
          updated_at?: string
        }
        Update: {
          assigned_source?: string | null
          assigned_staff_id?: string | null
          checklist_progress?: string[]
          checklist_template_id?: string | null
          completed_at?: string | null
          created_at?: string
          date?: string
          dnd_active?: boolean | null
          dnd_note?: string | null
          exception_at?: string | null
          exception_note?: string | null
          exception_type?: string | null
          help_requested?: boolean
          housekeeper_note?: string | null
          housekeeper_note_at?: string | null
          inspected_at?: string | null
          inspected_by?: string | null
          is_paused?: boolean
          is_rush?: boolean
          issue_note?: string | null
          manager_notes?: string | null
          manager_notes_at?: string | null
          manager_notes_by_account_id?: string | null
          marked_for_inspection_at?: string | null
          paused_at?: string | null
          property_id?: string
          room_number?: string
          rush_due_by?: string | null
          rush_duration_label?: string | null
          rush_requested_by_account_id?: string | null
          rush_set_at?: string | null
          rush_set_by?: string | null
          started_at?: string | null
          status?: string | null
          time_spent_minutes?: number | null
          total_paused_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_work_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_staff_fk"
            columns: ["assigned_staff_id", "property_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id", "property_id"]
          },
        ]
      }
      schedule_assignments: {
        Row: {
          crew: string[]
          csv_pulled_at: string | null
          csv_room_snapshot: Json | null
          date: string
          property_id: string
          room_assignments: Json
          shift_starts: Json
          staff_names: Json
          updated_at: string
        }
        Insert: {
          crew?: string[]
          csv_pulled_at?: string | null
          csv_room_snapshot?: Json | null
          date: string
          property_id: string
          room_assignments?: Json
          shift_starts?: Json
          staff_names?: Json
          updated_at?: string
        }
        Update: {
          crew?: string[]
          csv_pulled_at?: string | null
          csv_room_snapshot?: Json | null
          date?: string
          property_id?: string
          room_assignments?: Json
          shift_starts?: Json
          staff_names?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_templates: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          payload: Json
          property_id: string
          scope: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          payload: Json
          property_id: string
          scope: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          payload?: Json
          property_id?: string
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_week_signoffs: {
        Row: {
          finished_at: string
          finished_by: string | null
          id: string
          property_id: string
          week_start: string
        }
        Insert: {
          finished_at?: string
          finished_by?: string | null
          id?: string
          property_id: string
          week_start: string
        }
        Update: {
          finished_at?: string
          finished_by?: string | null
          id?: string
          property_id?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_week_signoffs_finished_by_fkey"
            columns: ["finished_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_week_signoffs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_shifts: {
        Row: {
          created_at: string
          department: string
          end_time: string
          filled_by_history: Json
          id: string
          kind: string
          note: string | null
          preset_id: string | null
          property_id: string
          reason: string | null
          shift_date: string
          staff_id: string | null
          start_time: string
          status: string
          time_off_override: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          department: string
          end_time: string
          filled_by_history?: Json
          id?: string
          kind?: string
          note?: string | null
          preset_id?: string | null
          property_id: string
          reason?: string | null
          shift_date: string
          staff_id?: string | null
          start_time: string
          status?: string
          time_off_override?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string
          end_time?: string
          filled_by_history?: Json
          id?: string
          kind?: string
          note?: string | null
          preset_id?: string | null
          property_id?: string
          reason?: string | null
          shift_date?: string
          staff_id?: string | null
          start_time?: string
          status?: string
          time_off_override?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_shifts_preset_id_fkey"
            columns: ["preset_id"]
            isOneToOne: false
            referencedRelation: "property_shift_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_shifts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_shifts_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_credentials: {
        Row: {
          ca_login_url: string
          ca_password_encrypted: string | null
          ca_username_encrypted: string | null
          created_at: string
          is_active: boolean
          notes: string | null
          pms_login_email: string | null
          pms_type: string
          property_id: string
          report_inbox_hash: string | null
          report_inbox_local_encrypted: string | null
          report_raw_retention_days: number | null
          report_sender_domains: string[]
          scraper_instance: string
          updated_at: string
        }
        Insert: {
          ca_login_url?: string
          ca_password_encrypted?: string | null
          ca_username_encrypted?: string | null
          created_at?: string
          is_active?: boolean
          notes?: string | null
          pms_login_email?: string | null
          pms_type?: string
          property_id: string
          report_inbox_hash?: string | null
          report_inbox_local_encrypted?: string | null
          report_raw_retention_days?: number | null
          report_sender_domains?: string[]
          scraper_instance?: string
          updated_at?: string
        }
        Update: {
          ca_login_url?: string
          ca_password_encrypted?: string | null
          ca_username_encrypted?: string | null
          created_at?: string
          is_active?: boolean
          notes?: string | null
          pms_login_email?: string | null
          pms_type?: string
          property_id?: string
          report_inbox_hash?: string | null
          report_inbox_local_encrypted?: string | null
          report_raw_retention_days?: number | null
          report_sender_domains?: string[]
          scraper_instance?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scraper_credentials_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_session: {
        Row: {
          created_at: string
          property_id: string
          refreshed_at: string
          state: Json
        }
        Insert: {
          created_at?: string
          property_id: string
          refreshed_at?: string
          state: Json
        }
        Update: {
          created_at?: string
          property_id?: string
          refreshed_at?: string
          state?: Json
        }
        Relationships: [
          {
            foreignKeyName: "scraper_session_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_confirmations: {
        Row: {
          created_at: string
          language: string
          property_id: string
          responded_at: string | null
          sent_at: string | null
          shift_date: string
          sms_error: string | null
          sms_sent: boolean
          staff_id: string
          staff_name: string
          staff_phone: string
          status: string
          token: string
        }
        Insert: {
          created_at?: string
          language?: string
          property_id: string
          responded_at?: string | null
          sent_at?: string | null
          shift_date: string
          sms_error?: string | null
          sms_sent?: boolean
          staff_id: string
          staff_name: string
          staff_phone: string
          status?: string
          token: string
        }
        Update: {
          created_at?: string
          language?: string
          property_id?: string
          responded_at?: string | null
          sent_at?: string | null
          shift_date?: string
          sms_error?: string | null
          sms_sent?: boolean
          staff_id?: string
          staff_name?: string
          staff_phone?: string
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_confirmations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_confirmations_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          auth_user_id: string | null
          can_inspect: boolean
          created_at: string
          days_worked_this_week: number | null
          department: string | null
          hourly_wage: number | null
          id: string
          is_active: boolean | null
          is_scheduling_manager: boolean | null
          is_senior: boolean
          language: string
          last_paired_at: string | null
          max_days_per_week: number | null
          max_weekly_hours: number
          name: string
          phone: string | null
          phone_lookup: string | null
          property_id: string
          schedule_priority: string | null
          scheduled_today: boolean
          updated_at: string
          vacation_dates: string[] | null
          weekly_hours: number
        }
        Insert: {
          auth_user_id?: string | null
          can_inspect?: boolean
          created_at?: string
          days_worked_this_week?: number | null
          department?: string | null
          hourly_wage?: number | null
          id?: string
          is_active?: boolean | null
          is_scheduling_manager?: boolean | null
          is_senior?: boolean
          language?: string
          last_paired_at?: string | null
          max_days_per_week?: number | null
          max_weekly_hours?: number
          name: string
          phone?: string | null
          phone_lookup?: string | null
          property_id: string
          schedule_priority?: string | null
          scheduled_today?: boolean
          updated_at?: string
          vacation_dates?: string[] | null
          weekly_hours?: number
        }
        Update: {
          auth_user_id?: string | null
          can_inspect?: boolean
          created_at?: string
          days_worked_this_week?: number | null
          department?: string | null
          hourly_wage?: number | null
          id?: string
          is_active?: boolean | null
          is_scheduling_manager?: boolean | null
          is_senior?: boolean
          language?: string
          last_paired_at?: string | null
          max_days_per_week?: number | null
          max_weekly_hours?: number
          name?: string
          phone?: string | null
          phone_lookup?: string | null
          property_id?: string
          schedule_priority?: string | null
          scheduled_today?: boolean
          updated_at?: string
          vacation_dates?: string[] | null
          weekly_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_aliases: {
        Row: {
          alias_norm: string | null
          alias_raw: string
          first_seen_at: string
          id: string
          last_seen_at: string
          property_id: string
          seen_count: number
          source: string
          staff_id: string | null
        }
        Insert: {
          alias_norm?: string | null
          alias_raw: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          property_id: string
          seen_count?: number
          source: string
          staff_id?: string | null
        }
        Update: {
          alias_norm?: string | null
          alias_raw?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          property_id?: string
          seen_count?: number
          source?: string
          staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_aliases_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_aliases_staff_fk"
            columns: ["staff_id", "property_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id", "property_id"]
          },
        ]
      }
      staff_breaks: {
        Row: {
          break_type: string
          business_date: string
          created_at: string
          ended_at: string | null
          id: string
          property_id: string
          staff_id: string
          started_at: string
        }
        Insert: {
          break_type: string
          business_date: string
          created_at?: string
          ended_at?: string | null
          id?: string
          property_id: string
          staff_id: string
          started_at: string
        }
        Update: {
          break_type?: string
          business_date?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          property_id?: string
          staff_id?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_breaks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_kudos: {
        Row: {
          category: string | null
          created_at: string
          given_by: string | null
          given_by_name: string | null
          id: string
          message: string
          property_id: string
          staff_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          given_by?: string | null
          given_by_name?: string | null
          id?: string
          message: string
          property_id: string
          staff_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          given_by?: string | null
          given_by_name?: string | null
          id?: string
          message?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_kudos_given_by_fkey"
            columns: ["given_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_kudos_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_kudos_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_link_tokens: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          last_used_at: string | null
          property_id: string
          revoked_at: string | null
          staff_id: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          last_used_at?: string | null
          property_id: string
          revoked_at?: string | null
          staff_id: string
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          last_used_at?: string | null
          property_id?: string
          revoked_at?: string | null
          staff_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_link_tokens_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_link_tokens_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_magic_codes: {
        Row: {
          code: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          hashed_token: string
          property_id: string
          staff_id: string
        }
        Insert: {
          code: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          hashed_token: string
          property_id: string
          staff_id: string
        }
        Update: {
          code?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          hashed_token?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_magic_codes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_magic_codes_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staxis_support_sessions: {
        Row: {
          access_mode: string
          approved_by_account_id: string | null
          created_at: string
          ended_at: string | null
          ended_by_account_id: string | null
          expires_at: string
          id: string
          operator_account_id: string
          organization_id: string | null
          property_id: string | null
          reason: string
          scope_type: string
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          access_mode?: string
          approved_by_account_id?: string | null
          created_at?: string
          ended_at?: string | null
          ended_by_account_id?: string | null
          expires_at: string
          id?: string
          operator_account_id: string
          organization_id?: string | null
          property_id?: string | null
          reason: string
          scope_type: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          access_mode?: string
          approved_by_account_id?: string | null
          created_at?: string
          ended_at?: string | null
          ended_by_account_id?: string | null
          expires_at?: string
          id?: string
          operator_account_id?: string
          organization_id?: string | null
          property_id?: string | null
          reason?: string
          scope_type?: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staxis_support_sessions_approved_by_account_id_fkey"
            columns: ["approved_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_ended_by_account_id_fkey"
            columns: ["ended_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_operator_account_id_fkey"
            columns: ["operator_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_processed_events: {
        Row: {
          event_id: string
          event_type: string
          metadata: Json | null
          processed_at: string
          property_id: string | null
        }
        Insert: {
          event_id: string
          event_type: string
          metadata?: Json | null
          processed_at?: string
          property_id?: string | null
        }
        Update: {
          event_id?: string
          event_type?: string
          metadata?: Json | null
          processed_at?: string
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_processed_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      supply_predictions: {
        Row: {
          date: string
          features_snapshot: Json | null
          id: string
          model_run_id: string
          predicted_at: string
          predicted_minutes_p25: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75: number | null
          predicted_minutes_p90: number | null
          property_id: string
          room_number: string
          staff_id: string
        }
        Insert: {
          date: string
          features_snapshot?: Json | null
          id?: string
          model_run_id: string
          predicted_at?: string
          predicted_minutes_p25?: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          property_id: string
          room_number: string
          staff_id: string
        }
        Update: {
          date?: string
          features_snapshot?: Json | null
          id?: string
          model_run_id?: string
          predicted_at?: string
          predicted_minutes_p25?: number | null
          predicted_minutes_p50?: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          property_id?: string
          room_number?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supply_predictions_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supply_predictions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supply_predictions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      supply_priors: {
        Row: {
          cohort_key: string
          id: string
          n_hotels_contributing: number
          prior_minutes_per_event: number
          prior_strength: number
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_event: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_event?: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      time_off_requests: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          deny_reason: string | null
          id: string
          property_id: string
          reason: string | null
          request_date: string
          staff_id: string
          status: string
          submitted_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          deny_reason?: string | null
          id?: string
          property_id: string
          reason?: string | null
          request_date: string
          staff_id: string
          status?: string
          submitted_at?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          deny_reason?: string | null
          id?: string
          property_id?: string
          reason?: string | null
          request_date?: string
          staff_id?: string
          status?: string
          submitted_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_off_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_off_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_off_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      trusted_devices: {
        Row: {
          absolute_expires_at: string
          account_id: string
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          last_seen_at: string
          token_hash: string
          user_agent: string | null
        }
        Insert: {
          absolute_expires_at?: string
          account_id: string
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          last_seen_at?: string
          token_hash: string
          user_agent?: string | null
        }
        Update: {
          absolute_expires_at?: string
          account_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          last_seen_at?: string
          token_hash?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trusted_devices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_feedback: {
        Row: {
          admin_note: string | null
          category: string
          created_at: string
          decision_id: string | null
          eval_case_name: string | null
          id: string
          message: string
          property_id: string | null
          rating: number | null
          resolved_at: string | null
          status: string
          user_display_name: string | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          admin_note?: string | null
          category?: string
          created_at?: string
          decision_id?: string | null
          eval_case_name?: string | null
          id?: string
          message: string
          property_id?: string | null
          rating?: number | null
          resolved_at?: string | null
          status?: string
          user_display_name?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          admin_note?: string | null
          category?: string
          created_at?: string
          decision_id?: string | null
          eval_case_name?: string | null
          id?: string
          message?: string
          property_id?: string | null
          rating?: number | null
          resolved_at?: string | null
          status?: string
          user_display_name?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_feedback_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "agent_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feedback_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_category_map: {
        Row: {
          bucket_key: string
          created_at: string
          created_by: string | null
          created_by_name: string | null
          id: string
          property_id: string
          vendor_id: string
        }
        Insert: {
          bucket_key: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          property_id: string
          vendor_id: string
        }
        Update: {
          bucket_key?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          property_id?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_category_map_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_category_map_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          account_number: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          knowledge_contact_id: string | null
          name: string
          notes: string | null
          order_method: string | null
          phone: string | null
          property_id: string
          review_state: string
          suggested_from: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          account_number?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          knowledge_contact_id?: string | null
          name: string
          notes?: string | null
          order_method?: string | null
          phone?: string | null
          property_id: string
          review_state?: string
          suggested_from?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          account_number?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          knowledge_contact_id?: string | null
          name?: string
          notes?: string | null
          order_method?: string | null
          phone?: string | null
          property_id?: string
          review_state?: string
          suggested_from?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendors_knowledge_contact_id_fkey"
            columns: ["knowledge_contact_id"]
            isOneToOne: false
            referencedRelation: "knowledge_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendors_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      walkthrough_runs: {
        Row: {
          ended_at: string | null
          id: string
          property_id: string
          started_at: string
          status: string
          step_count: number
          task: string
          user_id: string
        }
        Insert: {
          ended_at?: string | null
          id?: string
          property_id: string
          started_at?: string
          status?: string
          step_count?: number
          task: string
          user_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          property_id?: string
          started_at?: string
          status?: string
          step_count?: number
          task?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "walkthrough_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkthrough_runs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_log: {
        Row: {
          id: string
          payload: Json
          source: string | null
          ts: string
        }
        Insert: {
          id?: string
          payload?: Json
          source?: string | null
          ts?: string
        }
        Update: {
          id?: string
          payload?: Json
          source?: string | null
          ts?: string
        }
        Relationships: []
      }
      week_publications: {
        Row: {
          created_at: string
          id: string
          property_id: string
          published_at: string
          published_by: string | null
          week_start: string
        }
        Insert: {
          created_at?: string
          id?: string
          property_id: string
          published_at?: string
          published_by?: string | null
          week_start: string
        }
        Update: {
          created_at?: string
          id?: string
          property_id?: string
          published_at?: string
          published_by?: string | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "week_publications_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "week_publications_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      work_orders: {
        Row: {
          assigned_name: string | null
          assigned_to: string | null
          blocked_room: boolean | null
          ca_from_date: string | null
          ca_to_date: string | null
          ca_work_order_number: string | null
          completed_by_name: string | null
          completion_note: string | null
          completion_photo_path: string | null
          created_at: string | null
          description: string | null
          equipment_id: string | null
          id: string
          needs_pro: boolean
          notes: string | null
          photo_url: string | null
          preventive_task_id: string | null
          pro_called_at: string | null
          pro_company: string | null
          pro_phone: string | null
          pro_trade: string | null
          property_id: string | null
          repair_cost: number | null
          resolved_at: string | null
          room_number: string | null
          severity: string | null
          source: string | null
          status: string | null
          submitted_by: string | null
          submitted_by_name: string | null
          submitter_photo_path: string | null
          submitter_role: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_name?: string | null
          assigned_to?: string | null
          blocked_room?: boolean | null
          ca_from_date?: string | null
          ca_to_date?: string | null
          ca_work_order_number?: string | null
          completed_by_name?: string | null
          completion_note?: string | null
          completion_photo_path?: string | null
          created_at?: string | null
          description?: string | null
          equipment_id?: string | null
          id?: string
          needs_pro?: boolean
          notes?: string | null
          photo_url?: string | null
          preventive_task_id?: string | null
          pro_called_at?: string | null
          pro_company?: string | null
          pro_phone?: string | null
          pro_trade?: string | null
          property_id?: string | null
          repair_cost?: number | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string | null
          source?: string | null
          status?: string | null
          submitted_by?: string | null
          submitted_by_name?: string | null
          submitter_photo_path?: string | null
          submitter_role?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_name?: string | null
          assigned_to?: string | null
          blocked_room?: boolean | null
          ca_from_date?: string | null
          ca_to_date?: string | null
          ca_work_order_number?: string | null
          completed_by_name?: string | null
          completion_note?: string | null
          completion_photo_path?: string | null
          created_at?: string | null
          description?: string | null
          equipment_id?: string | null
          id?: string
          needs_pro?: boolean
          notes?: string | null
          photo_url?: string | null
          preventive_task_id?: string | null
          pro_called_at?: string | null
          pro_company?: string | null
          pro_phone?: string | null
          pro_trade?: string | null
          property_id?: string | null
          repair_cost?: number | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string | null
          source?: string | null
          status?: string | null
          submitted_by?: string | null
          submitted_by_name?: string | null
          submitter_photo_path?: string | null
          submitter_role?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_equipment_same_property_fk"
            columns: ["property_id", "equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["property_id", "id"]
          },
          {
            foreignKeyName: "work_orders_preventive_task_id_fkey"
            columns: ["preventive_task_id"]
            isOneToOne: false
            referencedRelation: "preventive_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_preventive_task_same_property_fk"
            columns: ["property_id", "preventive_task_id"]
            isOneToOne: false
            referencedRelation: "preventive_tasks"
            referencedColumns: ["property_id", "id"]
          },
          {
            foreignKeyName: "work_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_jobs: {
        Row: {
          attempts: number
          claude_cost_micros: number
          completed_at: string | null
          created_at: string
          error: string | null
          error_detail: Json | null
          expires_at: string
          id: string
          idempotency_key: string
          kind: string
          last_attempt_at: string | null
          max_attempts: number
          paused_reason: string | null
          payload: Json
          property_id: string
          result: Json | null
          started_at: string | null
          status: string
          triggered_by: string | null
          worker_machine_id: string | null
        }
        Insert: {
          attempts?: number
          claude_cost_micros?: number
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          expires_at?: string
          id?: string
          idempotency_key: string
          kind: string
          last_attempt_at?: string | null
          max_attempts?: number
          paused_reason?: string | null
          payload?: Json
          property_id: string
          result?: Json | null
          started_at?: string | null
          status?: string
          triggered_by?: string | null
          worker_machine_id?: string | null
        }
        Update: {
          attempts?: number
          claude_cost_micros?: number
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          expires_at?: string
          id?: string
          idempotency_key?: string
          kind?: string
          last_attempt_at?: string | null
          max_attempts?: number
          paused_reason?: string | null
          payload?: Json
          property_id?: string
          result?: Json | null
          started_at?: string | null
          status?: string
          triggered_by?: string | null
          worker_machine_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workflow_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      cleaning_minutes_per_day_view: {
        Row: {
          date: string | null
          n_events: number | null
          property_id: string | null
          total_approved_minutes: number | null
          total_recorded_minutes: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      headcount_actuals_view: {
        Row: {
          actual_headcount: number | null
          date: string | null
          labels_complete: boolean | null
          no_show_count: number | null
          property_id: string | null
          scheduled_headcount: number | null
          unmarked_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_observed_rate_v: {
        Row: {
          days_elapsed: number | null
          discards_in_window: number | null
          item_id: string | null
          newer_count_id: string | null
          newer_counted_at: string | null
          newer_stock: number | null
          observed_rate: number | null
          older_counted_at: string | null
          older_stock: number | null
          orders_in_window: number | null
          property_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      item_canonical_name_view: {
        Row: {
          item_canonical_name: string | null
          item_id: string | null
          item_name: string | null
          property_id: string | null
        }
        Insert: {
          item_canonical_name?: never
          item_id?: string | null
          item_name?: string | null
          property_id?: string | null
        }
        Update: {
          item_canonical_name?: never
          item_id?: string | null
          item_name?: string | null
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_effective_property_access: {
        Row: {
          access_profile: string | null
          account_id: string | null
          expires_at: string | null
          grant_id: string | null
          membership_id: string | null
          organization_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          scope_type: string | null
          source: string | null
          starts_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      pg_tables_policy_coverage: {
        Row: {
          has_tenant_column: boolean | null
          policy_count: number | null
          rls_enabled: boolean | null
          schemaname: unknown
          tablename: unknown
        }
        Relationships: []
      }
      pg_tables_rls_status: {
        Row: {
          forcerowsecurity: boolean | null
          rowsecurity: boolean | null
          schemaname: unknown
          tablename: unknown
        }
        Relationships: []
      }
      pms_channel_performance_current: {
        Row: {
          as_of: string | null
          average_lead_time_days: number | null
          average_length_of_stay: number | null
          bookings_count: number | null
          business_date: string | null
          business_date_source: string | null
          cancellation_rate_pct: number | null
          channel: string | null
          commission_paid_cents: number | null
          commission_rate_pct: number | null
          created_at: string | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          property_id: string | null
          raw: Json | null
          revenue_cents: number | null
          rooms_sold: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_channel_performance_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_channel_performance_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_delivery_signal_v1: {
        Row: {
          feed_key: string | null
          last_delivery_at: string | null
          property_id: string | null
        }
        Relationships: []
      }
      pms_feed_health_v1: {
        Row: {
          alert_channel: string | null
          cadence_kind: string | null
          enabled: boolean | null
          expected_at_local: string | null
          expected_every_minutes: number | null
          feed_key: string | null
          grace_minutes: number | null
          label: string | null
          last_delivery_at: string | null
          last_report_at: string | null
          last_signal_at: string | null
          legacy_target: string | null
          minutes_late: number | null
          open_quarantine_count: number | null
          open_unmapped_count: number | null
          property_id: string | null
          report_type: string | null
          required: boolean | null
          state: string | null
          target_table: string | null
          timezone: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_catalog_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
          {
            foreignKeyName: "pms_feed_expectations_feed_key_fkey"
            columns: ["feed_key"]
            isOneToOne: false
            referencedRelation: "pms_feed_catalog"
            referencedColumns: ["feed_key"]
          },
          {
            foreignKeyName: "pms_feed_expectations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_table_signal_v1: {
        Row: {
          last_report_at: string | null
          property_id: string | null
          target_table: string | null
        }
        Relationships: []
      }
      pms_forecast_daily_current: {
        Row: {
          booking_pace_indicator: string | null
          created_at: string | null
          forecast_date: string | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          projected_adr_cents: number | null
          projected_arrivals: number | null
          projected_departures: number | null
          projected_in_house: number | null
          projected_occupancy_pct: number | null
          projected_revenue_cents: number | null
          projected_revpar_cents: number | null
          property_id: string | null
          raw: Json | null
          snapshot_date: string | null
          vs_same_day_last_year_pct: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_forecast_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_forecast_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_in_house_snapshot: {
        Row: {
          arrivals_remaining_today: number | null
          cancellations_today: number | null
          captured_at: string | null
          checked_in_today_count: number | null
          checked_out_today_count: number | null
          departures_remaining_today: number | null
          has_error: boolean | null
          ingest_run_id: string | null
          last_error: string | null
          last_good_at: string | null
          last_synced_at: string | null
          no_shows_today: number | null
          property_id: string | null
          raw: Json | null
          revenue_today_so_far_cents: number | null
          special_needs_guests_in_house: number | null
          total_guests_in_house: number | null
          total_occupied_rooms: number | null
          total_ooo: number | null
          total_vacant_clean: number | null
          total_vacant_dirty: number | null
          vip_guests_in_house: number | null
          walk_ins_today: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_in_house_snapshot_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_in_house_snapshot_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_payments_daily_current: {
        Row: {
          as_of: string | null
          business_date: string | null
          business_date_source: string | null
          captured_at: string | null
          card_collected_cents: number | null
          cash_collected_cents: number | null
          created_at: string | null
          deposits_collected_cents: number | null
          id: string | null
          ingest_run_id: string | null
          property_id: string | null
          raw: Json | null
          total_collected_cents: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_payments_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_payments_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_property_health_v1: {
        Row: {
          feeds_learning: number | null
          feeds_live: number | null
          feeds_stale: number | null
          feeds_total: number | null
          feeds_unavailable: number | null
          newest_signal_at: string | null
          oldest_signal_at: string | null
          open_quarantine_total: number | null
          open_unmapped_total: number | null
          property_id: string | null
          required_feeds_degraded: number | null
          worst_minutes_late: number | null
          worst_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_expectations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_quarantine_rollup_v1: {
        Row: {
          deliveries_affected: number | null
          fingerprint: string | null
          first_seen_at: string | null
          last_seen_at: string | null
          latest_reason_detail: string | null
          open_rows: number | null
          property_id: string | null
          reason_code: string | null
          report_type: string | null
          target_table: string | null
          total_occurrences: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_quarantine_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_quarantine_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_rates_and_inventory_current: {
        Row: {
          as_of: string | null
          available_rooms: number | null
          captured_at: string | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          property_id: string | null
          rate_amount_cents: number | null
          rate_loaded_in_channel_manager: boolean | null
          rate_parity_status: Json | null
          rate_plan: string | null
          raw: Json | null
          room_type: string | null
          stay_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_rates_and_inventory_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_rates_and_inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_revenue_daily_current: {
        Row: {
          adjustments_cents: number | null
          adr_cents: number | null
          ancillary_revenue_cents: number | null
          as_of: string | null
          available_rooms: number | null
          business_date: string | null
          business_date_source: string | null
          channel_commission_breakdown: Json | null
          comps_cents: number | null
          created_at: string | null
          discounts_cents: number | null
          fnb_revenue_cents: number | null
          goppar_cents: number | null
          gross_operating_profit_cents: number | null
          group_revenue_cents: number | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          occupancy_pct: number | null
          occupied_rooms: number | null
          ooo_rooms: number | null
          ota_commission_paid_cents: number | null
          property_id: string | null
          raw: Json | null
          refunds_cents: number | null
          revpar_cents: number | null
          rooms_revenue_cents: number | null
          taxes_collected: Json | null
          total_revenue_cents: number | null
          transient_revenue_cents: number | null
          updated_at: string | null
          walk_in_revenue_cents: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_revenue_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_revenue_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_credentials_decrypted: {
        Row: {
          ca_login_url: string | null
          ca_password: string | null
          ca_username: string | null
          created_at: string | null
          is_active: boolean | null
          notes: string | null
          pms_type: string | null
          property_id: string | null
          scraper_instance: string | null
          updated_at: string | null
        }
        Insert: {
          ca_login_url?: string | null
          ca_password?: never
          ca_username?: never
          created_at?: string | null
          is_active?: boolean | null
          notes?: string | null
          pms_type?: string | null
          property_id?: string | null
          scraper_instance?: string | null
          updated_at?: string | null
        }
        Update: {
          ca_login_url?: string | null
          ca_password?: never
          ca_username?: never
          created_at?: string | null
          is_active?: boolean | null
          notes?: string | null
          pms_type?: string | null
          property_id?: string | null
          scraper_instance?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scraper_credentials_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      walkthrough_runs_daily: {
        Row: {
          avg_steps_to_done: number | null
          cannot_help: number | null
          completed: number | null
          day: string | null
          errored: number | null
          hit_step_cap: number | null
          still_active: number | null
          timed_out: number | null
          total: number | null
          user_stopped: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      _activity_log_resolve_actor: {
        Args: { p_staff_id: string; p_user_id: string }
        Returns: {
          account_id: string
          actor_name: string
          actor_role: string
        }[]
      }
      _activity_log_write: {
        Args: {
          p_actor_staff_id: string
          p_actor_user_id: string
          p_description: string
          p_event_category: string
          p_event_type: string
          p_metadata: Json
          p_occurred_at: string
          p_property_id: string
          p_source: string
          p_source_event_id: string
          p_target_id: string
          p_target_label: string
          p_target_type: string
        }
        Returns: undefined
      }
      _pms_lineage_tables: { Args: never; Returns: string[] }
      _staxis_account_ambiguous_portfolio_organizations: {
        Args: { p_account_id: string }
        Returns: {
          organization_id: string
        }[]
      }
      _staxis_account_authorized_portfolio_catalog: {
        Args: {
          p_account_id: string
          p_authorized_property_ids: string[]
          p_organization_id: string
        }
        Returns: Json
      }
      _staxis_account_can_manage_users_at_property: {
        Args: { p_account_id: string; p_property_id: string }
        Returns: boolean
      }
      _staxis_account_has_company_manager_hierarchy_at_property: {
        Args: { p_account_id: string; p_property_id: string }
        Returns: boolean
      }
      _staxis_account_has_company_people_authority_at_property: {
        Args: { p_account_id: string; p_property_id: string }
        Returns: boolean
      }
      _staxis_account_is_current_nudge_recipient: {
        Args: { p_account_id: string; p_property_id: string }
        Returns: boolean
      }
      _staxis_account_is_live_organization_owner: {
        Args: { p_account_id: string }
        Returns: boolean
      }
      _staxis_account_operational_role_at_property: {
        Args: { p_account_id: string; p_property_id: string }
        Returns: string
      }
      _staxis_account_property_authorizations: {
        Args: { p_account_id: string }
        Returns: {
          access_profile: string
          account_id: string
          can_portfolio_intelligence: boolean
          entitlement_id: string
          entitlement_kind: string
          membership_id: string
          organization_id: string
          portfolio_id: string
          property_id: string
          scope_type: string
          staxis_role: string
        }[]
      }
      _staxis_admin_hotel_relationship_revision: {
        Args: { p_property_id: string }
        Returns: string
      }
      _staxis_append_company_knowledge_revision: {
        Args: {
          p_action: string
          p_actor_account_id: string
          p_actor_kind: string
          p_after_snapshot: Json
          p_before_snapshot: Json
          p_fact_id: string
          p_fact_revision: number
          p_merge_role: string
          p_occurred_at?: string
          p_operation_id: string
          p_organization_id: string
          p_related_fact_id: string
          p_request_id: string
          p_source: string
        }
        Returns: string
      }
      _staxis_assert_active_platform_admin: {
        Args: { p_actor_account_id: string }
        Returns: undefined
      }
      _staxis_authoritative_property_standing_for_auth_user: {
        Args: { p_auth_user_id: string; p_property_id: string }
        Returns: Json
      }
      _staxis_authorization_scope_receipt_json: {
        Args: { p_receipt_id: string }
        Returns: Json
      }
      _staxis_authorized_portfolio_catalog: {
        Args: { p_authorized_property_ids: string[]; p_organization_id: string }
        Returns: Json
      }
      _staxis_can_control_account_invite: {
        Args: {
          p_actor_account_id: string
          p_covered_property_ids: string[]
          p_hotel_id: string
          p_membership_scope: string
          p_organization_id: string
          p_role: string
        }
        Returns: boolean
      }
      _staxis_can_delegate_organization_access: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_id: string
          p_scope_type: string
        }
        Returns: boolean
      }
      _staxis_can_set_membership_hat: {
        Args: {
          p_actor_account_id: string
          p_membership_scope: string
          p_organization_id: string
          p_property_ids: string[]
          p_staxis_role: string
        }
        Returns: boolean
      }
      _staxis_change_hotel_team_role_guarded_legacy_impl: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_active: boolean
          p_expected_auth_user_id: string
          p_expected_display_name: string
          p_expected_intent_version: number
          p_expected_property_access: string[]
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
          p_new_display_name: string
          p_new_role: string
          p_request_id: string
          p_target_account_id: string
        }
        Returns: Json
      }
      _staxis_commit_company_access_hat_conversion: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_confirmed: boolean
          p_expected_access_epoch: number
          p_expected_access_revision: string
          p_expires_at: string
          p_idempotency_key: string
          p_membership_id: string
          p_operation: string
          p_organization_id: string
          p_portfolio_id: string
          p_preview_fingerprint: string
          p_property_ids: string[]
          p_scope_kind: string
        }
        Returns: Json
      }
      _staxis_company_access_can_delegate: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_id: string
          p_scope_type: string
        }
        Returns: boolean
      }
      _staxis_company_access_can_delegate_v0381: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_id: string
          p_scope_type: string
        }
        Returns: boolean
      }
      _staxis_company_access_can_retire_hat: {
        Args: { p_actor_account_id: string; p_membership_id: string }
        Returns: boolean
      }
      _staxis_company_access_hat_conversion_revision: {
        Args: { p_membership_id: string }
        Returns: string
      }
      _staxis_company_access_membership_revision: {
        Args: { p_membership_id: string }
        Returns: string
      }
      _staxis_company_access_scope_properties: {
        Args: {
          p_organization_id: string
          p_portfolio_id: string
          p_property_id: string
          p_scope_type: string
        }
        Returns: string[]
      }
      _staxis_company_authority_row_snapshot: {
        Args: {
          p_rule: Database["public"]["Tables"]["company_authority_rules"]["Row"]
        }
        Returns: Json
      }
      _staxis_company_authority_rule_snapshot: {
        Args: { p_fact_id: string }
        Returns: Json
      }
      _staxis_company_knowledge_editor_role: {
        Args: {
          p_actor_account_id: string
          p_organization_id: string
          p_receipt_id: string
        }
        Returns: string
      }
      _staxis_company_knowledge_snapshot: {
        Args: { p_fact_id: string }
        Returns: Json
      }
      _staxis_company_knowledge_snapshot_from_row: {
        Args: {
          p_authority: Json
          p_fact: Database["public"]["Tables"]["company_knowledge"]["Row"]
        }
        Returns: Json
      }
      _staxis_company_knowledge_snapshot_ok: {
        Args: {
          p_fact_id: string
          p_fact_revision: number
          p_organization_id: string
          p_snapshot: Json
        }
        Returns: boolean
      }
      _staxis_company_structure_actor_rights: {
        Args: { p_actor_account_id: string; p_organization_id: string }
        Returns: {
          authorized_property_ids: string[]
          can_manage_portfolios: boolean
          manageable_portfolio_ids: string[]
          whole_company_view: boolean
        }[]
      }
      _staxis_company_structure_manageable_property_ids: {
        Args: { p_actor_account_id: string; p_organization_id: string }
        Returns: string[]
      }
      _staxis_company_structure_portfolio_grants: {
        Args: { p_assigned_portfolio_ids: string[]; p_organization_id: string }
        Returns: {
          account_id: string
          grant_id: string
        }[]
      }
      _staxis_current_primary_property_relationships: {
        Args: never
        Returns: {
          active_primary_count: number
          ends_at: string
          id: string
          organization_id: string
          property_id: string
          relationship_type: string
          starts_at: string
        }[]
      }
      _staxis_jsonb_bounded_integer: {
        Args: { p_max: number; p_min: number; p_value: Json }
        Returns: boolean
      }
      _staxis_jsonb_canonical_text: { Args: { p_value: Json }; Returns: string }
      _staxis_jsonb_exact_keys: {
        Args: { p_keys: string[]; p_value: Json }
        Returns: boolean
      }
      _staxis_jsonb_has_join_code_bearer_key: {
        Args: { p_value: Json }
        Returns: boolean
      }
      _staxis_jsonb_identifier_or_null: {
        Args: { p_fingerprint?: boolean; p_value: Json }
        Returns: boolean
      }
      _staxis_lock_organization: {
        Args: { p_organization_id: string }
        Returns: undefined
      }
      _staxis_manage_team_context: {
        Args: { p_actor_account_id: string; p_property_id: string }
        Returns: Json
      }
      _staxis_nonlegacy_property_authorizations: {
        Args: { p_account_id: string }
        Returns: {
          access_profile: string
          account_id: string
          can_portfolio_intelligence: boolean
          entitlement_id: string
          entitlement_kind: string
          membership_id: string
          organization_id: string
          portfolio_id: string
          property_id: string
          scope_type: string
          staxis_role: string
        }[]
      }
      _staxis_organization_has_ambiguous_primary_topology: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      _staxis_portfolio_finding_claim_array_ok: {
        Args: { p_max: number; p_value: Json }
        Returns: boolean
      }
      _staxis_portfolio_finding_instant_ok: {
        Args: { p_value: Json }
        Returns: boolean
      }
      _staxis_portfolio_finding_plan_matches: {
        Args: { p_finding: Json; p_presentation_plan: Json }
        Returns: boolean
      }
      _staxis_portfolio_finding_producer_ok: {
        Args: {
          p_account_id: string
          p_authorization_hash: string
          p_authorized_count: number
          p_organization_id: string
          p_scope_hash: string
          p_scope_receipt_id: string
          p_selected_count: number
          p_status: string
          p_value: Json
        }
        Returns: boolean
      }
      _staxis_portfolio_finding_receipt_ok: {
        Args: {
          p_account_id: string
          p_authorization_hash: string
          p_authorized_count: number
          p_organization_id: string
          p_scope_hash: string
          p_scope_receipt_id: string
          p_selected_count: number
          p_value: Json
        }
        Returns: boolean
      }
      _staxis_portfolio_finding_summary_total: {
        Args: { p_max_count?: number; p_max_items?: number; p_value: Json }
        Returns: number
      }
      _staxis_portfolio_knowledge_claim_scope_ok: {
        Args: {
          p_claim: Json
          p_expected_property_id: string
          p_organization_id: string
        }
        Returns: boolean
      }
      _staxis_preview_admin_hotel_relationship: {
        Args: {
          p_actor_account_id: string
          p_expected_relationship_revision: string
          p_property_id: string
          p_relationship_type: string
          p_target_organization_id: string
        }
        Returns: Json
      }
      _staxis_preview_company_access_edit: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_expected_access_epoch: number
          p_expected_access_revision: string
          p_expires_at: string
          p_membership_id: string
          p_operation: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_ids: string[]
          p_scope_kind: string
        }
        Returns: Json
      }
      _staxis_preview_company_access_hat_conversion: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_expected_access_epoch: number
          p_expected_access_revision: string
          p_expires_at: string
          p_membership_id: string
          p_operation: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_ids: string[]
          p_scope_kind: string
        }
        Returns: Json
      }
      _staxis_preview_company_portfolio_assignment: {
        Args: {
          p_actor_account_id: string
          p_desired_portfolio_ids: string[]
          p_expected_access_epoch: number
          p_organization_id: string
          p_property_id: string
        }
        Returns: Json
      }
      _staxis_preview_company_portfolio_assignment_v0379: {
        Args: {
          p_actor_account_id: string
          p_desired_portfolio_ids: string[]
          p_expected_access_epoch: number
          p_organization_id: string
          p_property_id: string
        }
        Returns: Json
      }
      _staxis_reconcile_legacy_organization_access: {
        Args: { p_actor_account_id?: string; p_property_id?: string }
        Returns: Json
      }
      _staxis_redact_join_code_bearer_keys: {
        Args: { p_value: Json }
        Returns: Json
      }
      _staxis_refresh_account_authorization: {
        Args: { p_account_id: string; p_reason?: string }
        Returns: undefined
      }
      _staxis_remove_property_access_guarded_legacy_impl: {
        Args: {
          p_account_id: string
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
        }
        Returns: Json
      }
      _staxis_scheduled_grant_property_ids: {
        Args: { p_grant_id: string }
        Returns: string[]
      }
      _staxis_scheduled_membership_property_ids: {
        Args: { p_membership_id: string }
        Returns: string[]
      }
      _staxis_staff_join_code_authority_context: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_property_id: string
        }
        Returns: Json
      }
      _staxis_structural_account_property_ids: {
        Args: { p_account_id: string }
        Returns: string[]
      }
      _staxis_transfer_ownership_guarded_legacy_impl: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_new_active: boolean
          p_expected_new_auth_user_id: string
          p_expected_new_intent_version: number
          p_expected_new_property_access: string[]
          p_expected_new_role: string
          p_expected_old_active: boolean
          p_expected_old_auth_user_id: string
          p_expected_old_intent_version: number
          p_expected_old_property_access: string[]
          p_expected_old_role: string
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_operation_id: string
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      _staxis_unique_index_columns: {
        Args: { p_rel: unknown }
        Returns: string[][]
      }
      append_management_pattern_input_batch: {
        Args: {
          p_fencing_token: number
          p_metric_observations?: Json
          p_metric_source_facts?: Json
          p_organization_id: string
          p_owner_token: string
          p_run_id: string
          p_run_properties?: Json
        }
        Returns: {
          metric_observations_inserted: number
          metric_source_facts_inserted: number
          run_properties_inserted: number
        }[]
      }
      append_management_pattern_result_batch: {
        Args: {
          p_fencing_token: number
          p_organization_id: string
          p_owner_token: string
          p_results: Json
          p_run_id: string
        }
        Returns: {
          batch_hash: string
          outcome: string
          row_counts: Json
        }[]
      }
      claim_idempotency_key: {
        Args: { p_key: string; p_pid?: string; p_route: string }
        Returns: {
          claimed: boolean
          existing_response: Json
          existing_route: string
          existing_status: number
        }[]
      }
      claim_management_pattern_run: {
        Args: {
          p_cohort_policy_version: string
          p_cost_budget_microusd?: number
          p_db_query_budget?: number
          p_dedupe_policy_version: string
          p_duration_budget_ms?: number
          p_engine_version: string
          p_evaluation_at: string
          p_evidence_schema_version: number
          p_input_hash: string
          p_input_manifest?: Json
          p_lease_seconds?: number
          p_model_call_budget?: number
          p_model_versions?: Json
          p_normalization_policy_version: string
          p_organization_id: string
          p_owner_token: string
          p_portfolio_snapshot: Json
          p_portfolio_snapshot_hash: string
          p_projection_mode?: string
          p_run_key: string
          p_scope_policy_version: string
          p_source_as_of: string
          p_supersedes_run_id?: string
          p_token_budget?: number
          p_topology_as_of: string
          p_triggered_by?: string
          p_window_end: string
          p_window_start: string
        }
        Returns: {
          fencing_token: number
          lease_expires_at: string
          outcome: string
          run_id: string
        }[]
      }
      claim_pms_auth_code: {
        Args: {
          p_max_age_seconds?: number
          p_not_before?: string
          p_property_id: string
        }
        Returns: {
          code: string
          id: string
        }[]
      }
      cleanup_idempotency_log: { Args: never; Returns: number }
      complete_inspection_atomic: {
        Args: {
          p_correction_note: string
          p_correction_notice_sent_at: string
          p_escalated: boolean
          p_escalation_reason: string
          p_failed_items: Json
          p_inspection_id: string
          p_notes: string
          p_passed_items: Json
          p_property_id: string
          p_result: string
        }
        Returns: {
          checklist_id: string | null
          cleaning_task_id: string | null
          completed_at: string | null
          correction_notice_sent_at: string | null
          created_at: string
          escalated: boolean
          escalation_reason: string | null
          failed_items: Json
          housekeeper_staff_id: string | null
          id: string
          inspector_staff_id: string | null
          notes: string | null
          parent_inspection_id: string | null
          passed_items: Json
          property_id: string
          recheck_inspection_id: string | null
          result: string
          room_id: string | null
          room_number: string
          started_at: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "inspections"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      decrypt_pms_credential: { Args: { ciphertext: string }; Returns: string }
      encrypt_pms_credential: { Args: { plaintext: string }; Returns: string }
      exec_sql: { Args: { sql: string }; Returns: Json }
      expire_stale_help_requests: {
        Args: never
        Returns: {
          id: string
          screenshot_storage_path: string
        }[]
      }
      finalize_management_pattern_run: {
        Args: {
          p_abstention_count?: number
          p_candidate_count?: number
          p_check_count?: number
          p_cohort_count?: number
          p_cohort_member_count?: number
          p_completion_token_count?: number
          p_cost_summary?: Json
          p_db_query_count?: number
          p_duration_ms?: number
          p_error_detail?: Json
          p_estimated_cost_microusd?: number
          p_excluded_property_count?: number
          p_fencing_token: number
          p_included_property_count?: number
          p_model_call_count?: number
          p_observation_count?: number
          p_observation_link_count?: number
          p_organization_id: string
          p_outcome_count?: number
          p_owner_token: string
          p_performance_summary?: Json
          p_prompt_token_count?: number
          p_property_count?: number
          p_quality_failure_count?: number
          p_quality_summary?: Json
          p_run_id: string
          p_source_fact_count?: number
          p_terminal_status: string
        }
        Returns: {
          outcome: string
          run_id: string
        }[]
      }
      heartbeat_management_pattern_run: {
        Args: {
          p_fencing_token: number
          p_lease_seconds?: number
          p_organization_id: string
          p_owner_token: string
          p_run_id: string
        }
        Returns: {
          lease_expires_at: string
          outcome: string
        }[]
      }
      is_admin_user: { Args: { uid: string }; Returns: boolean }
      load_management_pattern_portfolio_findings_source: {
        Args: {
          p_account_id: string
          p_as_of: string
          p_max_findings?: number
          p_scope_receipt_id: string
        }
        Returns: Json
      }
      load_management_pattern_source_snapshot: {
        Args: {
          p_activity_history_days?: number
          p_evaluation_at: string
          p_max_properties?: number
          p_organization_id: string
          p_source_as_of: string
          p_supply_window_end: string
          p_supply_window_start: string
          p_topology_as_of: string
        }
        Returns: Json
      }
      management_pattern_profile_at_v1: {
        Args: {
          p_organization_id: string
          p_property_id: string
          p_property_relationship_id: string
          p_source_as_of: string
          p_topology_as_of: string
        }
        Returns: {
          amenity_tags: string[]
          brand_class: string
          business_date_cutoff_hour: number
          comparison_attributes: Json
          created_at: string
          currency_code: string
          currency_minor_unit_exponent: number
          effective_from: string
          effective_to: string
          id: string
          location_type: string
          market_type: string
          operating_model: string
          profile_version: number
          room_count: number
          service_level: string
          source_kind: string
          source_reference: string
          timezone_name: string
        }[]
      }
      mfa_verified_or_grace: { Args: never; Returns: boolean }
      pms_delivery_quarantine_count: {
        Args: { p_delivery_id: string }
        Returns: number
      }
      pms_feed_minutes_late: {
        Args: {
          p_cadence_kind: string
          p_expected_at_local: string
          p_expected_every_minutes: number
          p_last_signal_at: string
          p_now: string
          p_timezone: string
        }
        Returns: number
      }
      pms_lineage_gaps: {
        Args: never
        Returns: {
          missing_table: string
          reason: string
        }[]
      }
      project_management_pattern_candidate: {
        Args: { p_candidate_id: string; p_organization_id: string }
        Returns: {
          finding_id: string
          outcome: string
        }[]
      }
      project_management_pattern_run: {
        Args: { p_organization_id: string; p_run_id: string }
        Returns: {
          candidate_projection_count: number
          details: Json
          outcome: string
          resolved_count: number
        }[]
      }
      project_property_counts_v1: {
        Args: { p_property_id: string; p_target_date: string }
        Returns: {
          arrival_room_numbers: string[]
          arrivals: number
          checkout_room_numbers: string[]
          checkouts: number
          ooo: number
          stayover_arrival_day: number
          stayover_day1: number
          stayover_day1_room_numbers: string[]
          stayover_day2: number
          stayover_unknown: number
          stayovers: number
          total_rooms: number
          vacant_clean: number
          vacant_dirty: number
        }[]
      }
      promote_shadow_model_run: {
        Args: { p_active_id: string; p_shadow_id: string }
        Returns: undefined
      }
      reassign_cleaning_task: {
        Args: {
          p_assigned_by_user: string
          p_property_id: string
          p_reason: string
          p_task_id: string
          p_to_housekeeper_id: string
        }
        Returns: {
          assignee_id: string
          noop: boolean
          task_id: string
        }[]
      }
      replace_labor_wage_settings: {
        Args: { p_property_id: string; p_rows: Json; p_updated_by: string }
        Returns: undefined
      }
      staxis_2fa_enabled: { Args: never; Returns: boolean }
      staxis_accept_account_invite: {
        Args: {
          p_auth_user_id: string
          p_claim_token: string
          p_display_name: string
          p_token_hash: string
          p_username: string
        }
        Returns: Json
      }
      staxis_accept_organization_invitation: {
        Args: { p_account_id: string; p_token_hash: string }
        Returns: {
          grant_id: string
          membership_id: string
        }[]
      }
      staxis_account_reaches_property: {
        Args: { p_property_id: string; p_user_id: string }
        Returns: boolean
      }
      staxis_acquire_portfolio_query_lease: {
        Args: {
          p_account_id: string
          p_lease_seconds?: number
          p_lease_token: string
          p_organization_id: string
        }
        Returns: Json
      }
      staxis_activate_ai_feature_config: {
        Args: {
          p_action: string
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_config_id: string
          p_expected_active_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_activate_prompt: {
        Args: { p_id: string; p_pms_family?: string; p_role: string }
        Returns: undefined
      }
      staxis_active_property_ids_for_nudges: {
        Args: { p_window_days?: number }
        Returns: {
          property_id: string
        }[]
      }
      staxis_admin_hotel_relationship_projection: {
        Args: {
          p_actor_account_id: string
          p_organization_query?: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_agent_costs_attribution_start: { Args: never; Returns: string }
      staxis_api_limit_cleanup: { Args: never; Returns: number }
      staxis_api_limit_hit: {
        Args: {
          p_endpoint: string
          p_hour_bucket: string
          p_property_id: string
        }
        Returns: number
      }
      staxis_append_inventory_audit_event: {
        Args: {
          p_action: string
          p_actor_name: string
          p_actor_user_id: string
          p_after_state: Json
          p_before_state: Json
          p_dedupe_key: string
          p_details: Json
          p_entity_id: string
          p_entity_key: string
          p_entity_type: string
          p_financial_details: Json
          p_occurred_at: string
          p_property_id: string
          p_request_id: string
          p_source_id: string
          p_source_table: string
          p_summary: Json
        }
        Returns: string
      }
      staxis_apply_company_knowledge_mutation_v1: {
        Args: {
          p_action: string
          p_actor_account_id: string
          p_authority_action_kind?: string
          p_authority_approver_role?: string
          p_authority_threshold_cents?: number
          p_authority_threshold_inclusive?: boolean
          p_cap?: number
          p_category?: string
          p_content?: string
          p_created_by_name?: string
          p_created_by_role?: string
          p_expected_revision?: number
          p_fact_id?: string
          p_organization_id: string
          p_policy_key?: string
          p_policy_value?: string
          p_related_expected_revision?: number
          p_related_fact_id?: string
          p_request_id?: string
          p_scope_receipt_id: string
          p_source?: string
          p_topic?: string
        }
        Returns: Json
      }
      staxis_apply_conversation_summary: {
        Args: {
          p_conversation_id: string
          p_cost_usd: number
          p_model: string
          p_model_id: string
          p_summarized_message_ids: string[]
          p_summary_content: string
          p_tokens_in: number
          p_tokens_out: number
        }
        Returns: string
      }
      staxis_apply_onboarding_join_code_transition: {
        Args: {
          p_code_id: string
          p_hotel_id: string
          p_request_id?: string
          p_transition: string
        }
        Returns: Json
      }
      staxis_archive_conversation: {
        Args: { p_conversation_id: string; p_min_age_days?: number }
        Returns: number
      }
      staxis_assert_authorization_scope_receipt: {
        Args: { p_account_id: string; p_receipt_id: string }
        Returns: Json
      }
      staxis_bootstrap_organization_leader_invitation: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_email: string
          p_expires_at?: string
          p_job_category: string
          p_job_title: string
          p_organization_id: string
          p_token_hash: string
        }
        Returns: string
      }
      staxis_business_date: {
        Args: { p_instant: string; p_property_id: string }
        Returns: string
      }
      staxis_cancel_agent_spend: {
        Args: { p_reservation_id: string }
        Returns: undefined
      }
      staxis_cancel_findings_spend: {
        Args: { p_reservation_id: string }
        Returns: undefined
      }
      staxis_cancel_organization_invitation: {
        Args: {
          p_actor_account_id: string
          p_invitation_id: string
          p_reason: string
        }
        Returns: boolean
      }
      staxis_cancel_phone_pairing_send: {
        Args: {
          p_challenge_token_hash: string
          p_pairing_id: string
          p_send_count: number
          p_send_reservation_id: string
        }
        Returns: boolean
      }
      staxis_change_hotel_team_role_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_active: boolean
          p_expected_auth_user_id: string
          p_expected_display_name: string
          p_expected_intent_version: number
          p_expected_property_access: string[]
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
          p_new_display_name: string
          p_new_role: string
          p_request_id: string
          p_target_account_id: string
        }
        Returns: Json
      }
      staxis_change_organization_membership_status: {
        Args: {
          p_action: string
          p_actor_account_id: string
          p_membership_id: string
          p_reason: string
        }
        Returns: boolean
      }
      staxis_check_ownership_transfer_replay: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_operation_id: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_claim_account_invite_acceptance: {
        Args: { p_claim_token: string; p_token_hash: string }
        Returns: Json
      }
      staxis_claim_account_lifecycle_intent: {
        Args: {
          p_lease_seconds?: number
          p_operation_id: string
          p_processor_token: string
        }
        Returns: Json
      }
      staxis_claim_join_code_slot: {
        Args: { p_expected_used_count: number; p_id: string }
        Returns: Json
      }
      staxis_claim_next_job: {
        Args: { p_worker_id: string }
        Returns: {
          force_remap: boolean
          id: string
          pms_type: string
          property_id: string
          started_at: string
          worker_id: string
        }[]
      }
      staxis_claim_next_pull_job: {
        Args: { p_worker_id: string }
        Returns: {
          id: string
          pms_type: string
          property_id: string
          recipe_id: string
          scheduled_for: string
          started_at: string
          worker_id: string
        }[]
      }
      staxis_claim_password_signin_proof: {
        Args: { p_user_id: string }
        Returns: string
      }
      staxis_claim_phone_pairing: {
        Args: {
          p_challenge_token_hash: string
          p_pairing_token_hash: string
          p_phone_ip?: string
          p_phone_user_agent?: string
        }
        Returns: {
          account_id: string
          auth_user_id: string
          challenge_expires_at: string
          newly_claimed: boolean
          pairing_id: string
          send_count: number
          send_reservation_id: string
        }[]
      }
      staxis_classify_memory_category: {
        Args: { p_content: string; p_topic: string }
        Returns: string
      }
      staxis_cleanup_phone_pairings: {
        Args: { p_account_id: string }
        Returns: number
      }
      staxis_close_inventory_month_close: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_manual_purchase_cents: number
          p_month_start: string
          p_notes: string
          p_property_id: string
          p_purchase_source: string
          p_request_id: string
        }
        Returns: string
      }
      staxis_commit_account_lifecycle_intent: {
        Args: {
          p_operation_id: string
          p_processor_token: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_commit_admin_hotel_relationship: {
        Args: {
          p_actor_account_id: string
          p_confirmed: boolean
          p_expected_relationship_revision: string
          p_idempotency_key: string
          p_preview_fingerprint: string
          p_property_id: string
          p_relationship_type: string
          p_target_organization_id: string
        }
        Returns: Json
      }
      staxis_commit_company_access_edit: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_confirmed: boolean
          p_expected_access_epoch: number
          p_expected_access_revision: string
          p_expires_at: string
          p_idempotency_key: string
          p_membership_id: string
          p_operation: string
          p_organization_id: string
          p_portfolio_id: string
          p_preview_fingerprint: string
          p_property_ids: string[]
          p_scope_kind: string
        }
        Returns: Json
      }
      staxis_commit_company_access_edit_v2: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_confirmed: boolean
          p_expected_access_epoch: number
          p_expected_access_revision: string
          p_expires_at: string
          p_idempotency_key: string
          p_membership_id: string
          p_operation: string
          p_organization_id: string
          p_portfolio_id: string
          p_preview_fingerprint: string
          p_property_ids: string[]
          p_scope_kind: string
        }
        Returns: Json
      }
      staxis_commit_company_portfolio_assignment: {
        Args: {
          p_actor_account_id: string
          p_confirmed: boolean
          p_desired_portfolio_ids: string[]
          p_expected_access_epoch: number
          p_idempotency_key: string
          p_organization_id: string
          p_preview_fingerprint: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_commit_portfolio_conversation_turn: {
        Args: {
          p_assistant_text: string
          p_authorization_hash: string
          p_conversation_id: string
          p_cost_usd: number
          p_model: string
          p_model_id: string
          p_organization_id: string
          p_prompt_version: string
          p_query_receipt_id: string
          p_scope_receipt_id: string
          p_tokens_in: number
          p_tokens_out: number
          p_user_account_id: string
          p_user_message: string
        }
        Returns: Json
      }
      staxis_company_access_editor_projection: {
        Args: { p_actor_account_id: string }
        Returns: Json
      }
      staxis_company_access_editor_projection_v2: {
        Args: { p_actor_account_id: string }
        Returns: Json
      }
      staxis_company_access_feed: {
        Args: { p_actor_account_id: string; p_limit?: number }
        Returns: Json
      }
      staxis_company_knowledge_ledger_capability: { Args: never; Returns: Json }
      staxis_company_structure_projection: {
        Args: { p_actor_account_id: string }
        Returns: Json
      }
      staxis_compensate_account_lifecycle_intent: {
        Args: {
          p_operation_id: string
          p_processor_token: string
          p_reason: string
        }
        Returns: Json
      }
      staxis_complete_phone_pairing: {
        Args: {
          p_completion_token_hash: string
          p_device_expires_at: string
          p_device_token_hash: string
          p_ip?: string
          p_session_id: string
          p_user_agent?: string
          p_user_id: string
        }
        Returns: string
      }
      staxis_correct_inventory_delivery: {
        Args: {
          p_corrected_at: string
          p_corrected_by: string
          p_lines: Json
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_correct_inventory_delivery_0334_impl: {
        Args: {
          p_corrected_at: string
          p_corrected_by: string
          p_lines: Json
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_count_finalize_failures_today: { Args: never; Returns: number }
      staxis_count_stale_reservations: {
        Args: { p_max_age_minutes?: number }
        Returns: number
      }
      staxis_count_swept_today: { Args: never; Returns: number }
      staxis_create_account_invite_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_covered_property_ids: string[]
          p_email: string
          p_expires_at: string
          p_hotel_id: string
          p_membership_scope: string
          p_organization_id: string
          p_request_id?: string
          p_role: string
          p_token_hash: string
        }
        Returns: Json
      }
      staxis_create_ai_feature_config: {
        Args: {
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_change_reason: string
          p_enabled: boolean
          p_fallback_model_id: string
          p_fallback_provider: string
          p_feature_key: string
          p_parameters: Json
          p_parent_id: string
          p_primary_model_id: string
          p_primary_provider: string
          p_request_id: string
        }
        Returns: string
      }
      staxis_create_inventory_vendor: {
        Args: {
          p_account_number: string
          p_actor_id: string
          p_actor_name: string
          p_email: string
          p_is_active: boolean
          p_name: string
          p_notes: string
          p_phone: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_create_organization: {
        Args: {
          p_actor_account_id: string
          p_name: string
          p_organization_type: string
        }
        Returns: string
      }
      staxis_create_organization_access_request: {
        Args: {
          p_actor_account_id: string
          p_membership_id: string
          p_portfolio_id?: string
          p_property_id?: string
          p_reason: string
          p_requested_access_profile: string
          p_scope_type: string
        }
        Returns: string
      }
      staxis_create_organization_invitation: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_email: string
          p_expires_at?: string
          p_grant_expires_at?: string
          p_job_category: string
          p_job_title: string
          p_organization_id: string
          p_portfolio_id?: string
          p_property_id?: string
          p_scope_type: string
          p_token_hash: string
        }
        Returns: string
      }
      staxis_create_portfolio_conversation: {
        Args: {
          p_authorization_hash: string
          p_organization_id: string
          p_prompt_version: string
          p_property_anchor_id: string
          p_role: string
          p_scope_receipt_id: string
          p_title: string
          p_user_account_id: string
          p_user_message: string
        }
        Returns: {
          conversation_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_create_structured_issue: {
        Args: {
          p_action: string
          p_item: string
          p_location_detail: string
          p_note: string
          p_property_id: string
          p_reporter_staff_id: string
          p_room_number: string
          p_severity: string
        }
        Returns: string
      }
      staxis_cua_increment_spend: {
        Args: { p_micros: number; p_property_id: string }
        Returns: {
          new_total_micros: number
          resets_at: string
          status: string
        }[]
      }
      staxis_current_user_can_receive_property_nudge: {
        Args: { p_account_id: string; p_property_id: string }
        Returns: boolean
      }
      staxis_decide_staff_join_request: {
        Args: {
          p_actor_account_id: string
          p_decision: string
          p_join_request_id: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_delete_property_and_legacy_accounts: {
        Args: {
          p_actor_account_id: string
          p_confirmed_name?: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_delete_property_conversation: {
        Args: {
          p_conversation_id: string
          p_property_id: string
          p_user_account_id: string
        }
        Returns: boolean
      }
      staxis_end_membership_hat: {
        Args: { p_actor_account_id: string; p_membership_id: string }
        Returns: boolean
      }
      staxis_end_membership_hat_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_audit_request_id?: string
          p_membership_id: string
        }
        Returns: Json
      }
      staxis_enqueue_pms_write: {
        Args: {
          p_action_key: string
          p_allow_enqueue: boolean
          p_changed_by: string
          p_payload: Json
          p_property_id: string
          p_room_number: string
          p_status: string
        }
        Returns: string
      }
      staxis_enqueue_property_pull: {
        Args: {
          p_pms_type: string
          p_property_id: string
          p_scheduled_for?: string
        }
        Returns: string
      }
      staxis_execute_finding_action: {
        Args: {
          p_account_id: string
          p_action_id: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_finalize_agent_spend:
        | {
            Args: {
              p_actual_usd: number
              p_cached_input_tokens: number
              p_conversation_id: string
              p_model: string
              p_model_id: string
              p_reservation_id: string
              p_tokens_in: number
              p_tokens_out: number
            }
            Returns: undefined
          }
        | {
            Args: {
              p_actual_usd: number
              p_cached_input_tokens: number
              p_conversation_id: string
              p_feature: string
              p_model: string
              p_model_id: string
              p_reservation_id: string
              p_tokens_in: number
              p_tokens_out: number
            }
            Returns: undefined
          }
      staxis_finalize_company_knowledge_revision_ledger: {
        Args: { p_expected_schema_version: string }
        Returns: Json
      }
      staxis_finalize_findings_spend: {
        Args: {
          p_actual_usd: number
          p_model: string
          p_model_id: string
          p_reservation_id: string
          p_tokens_in: number
          p_tokens_out: number
        }
        Returns: undefined
      }
      staxis_finalize_join_code_signup: {
        Args: {
          p_auth_user_id: string
          p_code: string
          p_code_id: string
          p_display_name: string
          p_expected_used_count: number
          p_hotel_id: string
          p_language: string
          p_phone: string
          p_request_id: string
          p_requested_role: string
          p_username: string
        }
        Returns: Json
      }
      staxis_finalize_phone_pairing_send: {
        Args: {
          p_challenge_token_hash: string
          p_pairing_id: string
          p_send_count: number
          p_send_reservation_id: string
        }
        Returns: string
      }
      staxis_forget_memory: {
        Args: {
          p_property_id: string
          p_scope: string
          p_subject_account_id: string
          p_topic: string
        }
        Returns: number
      }
      staxis_get_account_lifecycle_intent: {
        Args: { p_operation_id: string }
        Returns: Json
      }
      staxis_get_or_create_staff_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_get_or_set_shift_start: {
        Args: {
          p_date: string
          p_default_at: string
          p_property: string
          p_staff: string
        }
        Returns: string
      }
      staxis_grant_organization_access: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_expires_at?: string
          p_membership_id: string
          p_portfolio_id?: string
          p_property_id?: string
          p_scope_type: string
          p_source?: string
          p_starts_at?: string
        }
        Returns: string
      }
      staxis_grant_property_access: {
        Args: { p_account_id: string; p_hotel_id: string }
        Returns: number
      }
      staxis_heal_conversation_counters: {
        Args: { p_dry_run?: boolean }
        Returns: {
          actual_msg_count: number
          actual_unsum_count: number
          conversation_id: string
          healed: boolean
          stored_msg_count: number
          stored_unsum_count: number
        }[]
      }
      staxis_insert_draft_recipe: {
        Args: {
          p_learned_by_property_id: string
          p_notes: string
          p_pms_type: string
          p_recipe: Json
        }
        Returns: {
          id: string
          version: number
        }[]
      }
      staxis_install_cold_start_model_run: {
        Args: {
          p_hyperparameters: Json
          p_item_id: string
          p_model_version: string
          p_posterior_params: Json
          p_property_id: string
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_install_demand_supply_cold_start: {
        Args: {
          p_hyperparameters: Json
          p_layer: string
          p_model_version: string
          p_posterior_params: Json
          p_property_id: string
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_install_housekeeping_model_run: {
        Args: {
          p_fields: Json
          p_layer: string
          p_property_id: string
          p_should_activate: boolean
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_install_inventory_model_run: {
        Args: {
          p_fields: Json
          p_item_id: string
          p_property_id: string
          p_should_activate: boolean
          p_should_shadow: boolean
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_inventory_archive_zero_evidence: {
        Args: { p_item_id: string; p_property_id: string }
        Returns: {
          activity_sequence: number
          evidence_at: string
          evidence_id: string
          evidence_kind: string
          unit_cost: number
        }[]
      }
      staxis_inventory_audit_actor_name: {
        Args: { p_user_id: string }
        Returns: string
      }
      staxis_inventory_has_stock_evidence: {
        Args: { p_item_id: string; p_property_id: string }
        Returns: boolean
      }
      staxis_inventory_usage_budget_snapshot: {
        Args: { p_month_start: string; p_property_id: string }
        Returns: {
          usage_budget_by_key: Json
          usage_budget_mode: string
          usage_budget_total_cents: number
        }[]
      }
      staxis_list_account_authorized_properties: {
        Args: { p_account_id: string }
        Returns: Json
      }
      staxis_list_authoritative_hotel_accounts: {
        Args: { p_include_platform_admins?: boolean; p_property_id: string }
        Returns: Json
      }
      staxis_list_inventory_archive_readiness: {
        Args: { p_item_ids: string[]; p_property_id: string }
        Returns: Json
      }
      staxis_list_inventory_audit_events: {
        Args: {
          p_before_sequence: number
          p_include_financials: boolean
          p_limit: number
          p_property_id: string
        }
        Returns: Json
      }
      staxis_list_inventory_delivery_corrections: {
        Args: {
          p_include_financials?: boolean
          p_property_id: string
          p_root_order_ids: string[]
        }
        Returns: Json
      }
      staxis_list_inventory_delivery_corrections_0334_impl: {
        Args: {
          p_include_financials?: boolean
          p_property_id: string
          p_root_order_ids: string[]
        }
        Returns: Json
      }
      staxis_list_inventory_financial_evidence: {
        Args: { p_property_id: string }
        Returns: Json
      }
      staxis_list_normalized_organization_owner_account_ids: {
        Args: { p_account_ids: string[] }
        Returns: string[]
      }
      staxis_list_property_nudge_recipients: {
        Args: { p_property_id: string }
        Returns: Json
      }
      staxis_load_and_record_user_turn: {
        Args: {
          p_conversation_id: string
          p_user_id: string
          p_user_message: string
        }
        Returns: Json
      }
      staxis_lock_conversation: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      staxis_lock_load_and_record_portfolio_user_turn: {
        Args: {
          p_authorization_hash: string
          p_conversation_id: string
          p_organization_id: string
          p_scope_receipt_id: string
          p_user_account_id: string
          p_user_message: string
        }
        Returns: {
          history_meta: Json
          history_rows: Json
          ok: boolean
          reason: string
        }[]
      }
      staxis_lock_load_and_record_user_turn: {
        Args: {
          p_conversation_id: string
          p_property_id: string
          p_user_account_id: string
          p_user_message: string
        }
        Returns: {
          history_rows: Json
          ok: boolean
          reason: string
        }[]
      }
      staxis_merge_services: {
        Args: { p_patch: Json; p_property_id: string }
        Returns: Json
      }
      staxis_mint_first_person_onboarding_invite: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_invited_email: string
          p_request_id: string
          p_role: string
        }
        Returns: Json
      }
      staxis_mint_privileged_onboarding_join_code: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_request_id: string
          p_role: string
        }
        Returns: Json
      }
      staxis_note_account_lifecycle_attempt: {
        Args: { p_error: string; p_operation_id: string }
        Returns: Json
      }
      staxis_parse_finite_numeric: {
        Args: { p_label: string; p_value: string }
        Returns: number
      }
      staxis_pms_purge_observations: {
        Args: { p_before: string; p_table: string }
        Returns: number
      }
      staxis_pms_registry_violations: {
        Args: never
        Returns: {
          table_name: string
          violation: string
        }[]
      }
      staxis_portfolio_booked_room_points: {
        Args: {
          p_baseline_dates?: string[]
          p_business_date: string
          p_property_id: string
        }
        Returns: {
          as_of_date: string
          ingest_run_id: string
          knowledge_file_id: string
          observed_at: string
          pace_id: string
          parser_name: string
          parser_version: string
          point_kind: string
          report_file_id: string
          rooms_available: number
          rooms_otb: number
          run_status: string
          source_captured_at: string
          source_kind: string
          stay_date: string
          target_date: string
        }[]
      }
      staxis_portfolio_feed_pulses: {
        Args: { p_organization_id: string; p_property_ids: string[] }
        Returns: {
          active_knowledge_present: boolean
          health_rows: Json
          property_id: string
          room_status_last_synced_at: string
          session_last_successful_read_at: string
          session_present: boolean
          snapshot_captured_at: string
        }[]
      }
      staxis_portfolio_property_knowledge: {
        Args: {
          p_as_of: string
          p_limit?: number
          p_organization_id: string
          p_property_ids: string[]
        }
        Returns: {
          authoring_organization_id: string | null
          category: string
          confidence: string
          content: string
          created_at: string
          created_by_account_id: string | null
          created_by_name: string | null
          created_by_role: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          last_used_at: string | null
          override_organization_id: string | null
          overrides_company_fact_id: string | null
          property_id: string
          review_state: string
          scope: string
          source: string
          source_conversation_id: string | null
          subject_account_id: string | null
          superseded_by: string | null
          topic: string
          updated_at: string
          use_count: number
        }[]
        SetofOptions: {
          from: "*"
          to: "agent_memory"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      staxis_portfolio_queue_actions: {
        Args: {
          p_finding_ids: string[]
          p_property_ids: string[]
          p_states: string[]
        }
        Returns: {
          action_kind: string
          changed_facts: Json | null
          created_at: string
          created_object_id: string | null
          created_object_table: string | null
          decided_at: string | null
          decided_by: string | null
          failure_reason: string | null
          finding_id: string
          id: string
          idempotency_key: string
          outcome_due_at: string | null
          outcome_facts: Json | null
          outcome_kind: string | null
          outcome_observed_at: string | null
          params: Json
          params_fingerprint: string
          property_id: string
          proposed_at: string
          receipt: Json | null
          state: string
          undo: Json | null
          undone_at: string | null
          undone_by: string | null
          updated_at: string
          verify: Json
        }[]
        SetofOptions: {
          from: "*"
          to: "finding_actions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      staxis_portfolio_queue_findings: {
        Args: {
          p_limit_per_property: number
          p_property_ids: string[]
          p_statuses: string[]
        }
        Returns: {
          acted_count: number
          as_of: string | null
          created_at: string
          dedupe_key: string
          detector_id: string
          disposition: string
          escalated_at: string | null
          evidence: Json
          first_seen_at: string
          id: string
          ignored_count: number
          judged_at: string | null
          judged_disposition: string | null
          judged_guard_rejected: boolean
          judged_input_hash: string | null
          judged_model: string | null
          judged_rank: number | null
          judged_rationale: string | null
          judged_source: string | null
          judged_summary_en: string | null
          judged_summary_es: string | null
          last_seen_at: string
          last_shown_on: string | null
          magnitude: number
          occurrence_count: number
          price_basis: string | null
          price_currency: string
          price_high_cents: number | null
          price_low_cents: number | null
          property_id: string
          receipt_query_id: string
          resolved_at: string | null
          severity: string
          shown_count: number
          silenced_at_magnitude: number | null
          status: string
          status_changed_at: string
          status_changed_by: string | null
          summary: string
          updated_at: string
          weakest_input_age_days: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "findings"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      staxis_portfolio_queue_latest_runs: {
        Args: { p_property_ids: string[] }
        Returns: {
          created_at: string
          detectors_checked: number
          detectors_dormant: number
          detectors_failed: number
          detectors_registered: number
          detectors_skipped: number
          duration_ms: number | null
          errors: Json
          findings_escalated: number
          findings_expired: number
          findings_opened: number
          findings_suppressed: number
          findings_updated: number
          id: string
          judge_cost_usd: number
          judge_findings: number
          judge_guard_rejections: number
          judge_mode: string | null
          property_id: string
          run_at: string
          run_date: string
        }[]
        SetofOptions: {
          from: "*"
          to: "finding_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      staxis_portfolio_tool_finding_counts: {
        Args: {
          p_organization_id: string
          p_property_ids: string[]
          p_statuses: string[]
        }
        Returns: {
          needs_decision_count: number
          open_count: number
          property_id: string
        }[]
      }
      staxis_portfolio_tool_findings: {
        Args: {
          p_limit_per_property: number
          p_organization_id: string
          p_property_ids: string[]
          p_statuses: string[]
        }
        Returns: {
          bucket_available: boolean
          property_id: string
          rows_json: Json
        }[]
      }
      staxis_portfolio_tool_hotels: {
        Args: { p_organization_id: string; p_property_ids: string[] }
        Returns: {
          name: string
          property_id: string
          timezone: string
          total_rooms: number
        }[]
      }
      staxis_portfolio_tool_inventory: {
        Args: {
          p_limit_per_property: number
          p_organization_id: string
          p_property_ids: string[]
        }
        Returns: {
          bucket_available: boolean
          property_id: string
          rows_json: Json
        }[]
      }
      staxis_portfolio_tool_inventory_orders: {
        Args: {
          p_limit_per_property: number
          p_organization_id: string
          p_property_ids: string[]
          p_since: string
        }
        Returns: {
          bucket_available: boolean
          property_id: string
          rows_json: Json
        }[]
      }
      staxis_portfolio_tool_work_order_counts: {
        Args: {
          p_organization_id: string
          p_property_ids: string[]
          p_since: string
        }
        Returns: {
          metric_count: number
          property_id: string
        }[]
      }
      staxis_portfolio_tool_work_orders: {
        Args: {
          p_financial_property_ids: string[]
          p_organization_id: string
          p_property_ids: string[]
          p_since: string
        }
        Returns: {
          high_open_count: number
          low_open_count: number
          normal_open_count: number
          opened_count: number
          property_id: string
          repair_cost_samples: number
          repair_cost_sum: number
          still_open_count: number
          ungraded_open_count: number
          urgent_open_count: number
        }[]
      }
      staxis_post_notice: {
        Args: {
          p_body_en: string
          p_body_es: string
          p_body_ht: string
          p_body_tl: string
          p_body_vi: string
          p_expires_at: string
          p_pinned: boolean
          p_posted_by_account_id: string
          p_property_id: string
        }
        Returns: string
      }
      staxis_preview_company_access_edit_v2: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_expected_access_epoch: number
          p_expected_access_revision: string
          p_expires_at: string
          p_membership_id: string
          p_operation: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_ids: string[]
          p_scope_kind: string
        }
        Returns: Json
      }
      staxis_promote_shadow_authorization: {
        Args: { p_account_id: string; p_reason: string }
        Returns: Json
      }
      staxis_property_section_enabled: {
        Args: { p_property_id: string; p_section: string }
        Returns: boolean
      }
      staxis_propose_promotion: {
        Args: {
          p_claim: string
          p_evidence_summary?: string
          p_evidence_window_end?: string
          p_evidence_window_start?: string
          p_holdout_validated?: boolean
          p_is_aggregate?: boolean
          p_observation_count?: number
          p_origin: string
          p_pms_family?: string
          p_preconditions?: string[]
          p_proposed_content: string
          p_source_kind: string
          p_source_property_ids?: string[]
          p_source_ref?: string
          p_source_tier?: string
          p_supporting_hotel_count?: number
          p_target_row_id?: string
          p_target_table?: string
          p_target_tier: string
          p_topic: string
        }
        Returns: {
          action: string
          promotion_id: string
        }[]
      }
      staxis_purge_authorization_scope_receipts: {
        Args: { p_before?: string; p_limit?: number }
        Returns: number
      }
      staxis_purge_expired_portfolio_records: {
        Args: {
          p_limit?: number
          p_receipt_before: string
          p_snapshot_before: string
        }
        Returns: {
          receipts_deleted: number
          snapshots_deleted: number
        }[]
      }
      staxis_purge_old_pull_jobs: { Args: never; Returns: number }
      staxis_read_staff_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_hotel_id: string
        }
        Returns: Json
      }
      staxis_realtime_columns: {
        Args: never
        Returns: {
          allowed_columns: string[]
          table_name: string
        }[]
      }
      staxis_realtime_publication_tables: {
        Args: never
        Returns: {
          tablename: string
        }[]
      }
      staxis_reap_stale_jobs: { Args: never; Returns: number }
      staxis_reap_stale_pull_jobs: { Args: never; Returns: number }
      staxis_receive_inventory_delivery: {
        Args: {
          p_lines: Json
          p_notes: string
          p_property_id: string
          p_received_at: string
          p_request_id: string
          p_vendor_name: string
        }
        Returns: Json
      }
      staxis_receive_inventory_delivery_0334_impl: {
        Args: {
          p_lines: Json
          p_notes: string
          p_property_id: string
          p_received_at: string
          p_request_id: string
          p_vendor_name: string
        }
        Returns: Json
      }
      staxis_receive_inventory_delivery_for_actor: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_lines: Json
          p_notes: string
          p_property_id: string
          p_received_at: string
          p_request_id: string
          p_vendor_name: string
        }
        Returns: Json
      }
      staxis_receive_po_lines: {
        Args: { p_lines: Json; p_po_id: string; p_property_id: string }
        Returns: undefined
      }
      staxis_receive_po_lines_v2: {
        Args: { p_lines: Json; p_po_id: string; p_property_id: string }
        Returns: undefined
      }
      staxis_reconcile_legacy_organization_access: {
        Args: { p_actor_account_id: string; p_property_id?: string }
        Returns: Json
      }
      staxis_record_account_lifecycle_auth_snapshot: {
        Args: {
          p_banned_until: string
          p_operation_id: string
          p_processor_token: string
        }
        Returns: Json
      }
      staxis_record_ai_feature_validation: {
        Args: {
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_checked_at: string
          p_config_id: string
          p_request_id: string
          p_validation_report: Json
          p_validation_status: string
        }
        Returns: undefined
      }
      staxis_record_assistant_turn: {
        Args: {
          p_conversation_id: string
          p_cost_usd: number
          p_model: string
          p_model_id: string
          p_prompt_version: string
          p_text: string
          p_tokens_in: number
          p_tokens_out: number
          p_tool_calls: Json
        }
        Returns: undefined
      }
      staxis_record_inventory_loss: {
        Args: {
          p_expected_stock: number
          p_item_id: string
          p_notes: string
          p_property_id: string
          p_quantity: number
          p_reason: string
          p_recorded_at: string
          p_recorded_by: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_record_inventory_loss_0334_impl: {
        Args: {
          p_expected_stock: number
          p_item_id: string
          p_notes: string
          p_property_id: string
          p_quantity: number
          p_reason: string
          p_recorded_at: string
          p_recorded_by: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_record_inventory_opening_adjustment: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_adjustment_quantity: number
          p_effective_at: string
          p_expected_stock: number
          p_item_id: string
          p_property_id: string
          p_request_id: string
          p_resulting_stock: number
          p_unit_cost: number
        }
        Returns: Json
      }
      staxis_record_inventory_order_intent: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_item_id: string
          p_ordered_at: string
          p_property_id: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_record_ml_failure: {
        Args: { p_err: string; p_kind: string; p_pid: string }
        Returns: undefined
      }
      staxis_refresh_ai_model_catalog: {
        Args: {
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_missing_model_ids: string[]
          p_models: Json
          p_provider: string
          p_refreshed_at: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_refresh_inventory_delivery_metadata: {
        Args: {
          p_changed_root_id: string
          p_item_id: string
          p_property_id: string
        }
        Returns: undefined
      }
      staxis_register_account_lifecycle_intent: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_desired_active: boolean
          p_expected_active: boolean
          p_expected_auth_user_id: string
          p_expected_intent_version: number
          p_expected_property_access: string[]
          p_expected_role: string
          p_hotel_id: string
          p_operation_id: string
          p_target_account_id: string
        }
        Returns: Json
      }
      staxis_release_account_invite_acceptance: {
        Args: { p_claim_token: string; p_invite_id: string }
        Returns: boolean
      }
      staxis_release_account_lifecycle_processor: {
        Args: { p_operation_id: string; p_processor_token: string }
        Returns: Json
      }
      staxis_release_join_code_slot: { Args: { p_id: string }; Returns: number }
      staxis_release_password_signin_proof: {
        Args: { p_id: string }
        Returns: undefined
      }
      staxis_release_portfolio_query_lease: {
        Args: {
          p_account_id: string
          p_lease_token: string
          p_organization_id: string
        }
        Returns: Json
      }
      staxis_remove_property_access: {
        Args: { p_account_id: string; p_hotel_id: string }
        Returns: number
      }
      staxis_remove_property_access_guarded: {
        Args: {
          p_account_id: string
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
        }
        Returns: Json
      }
      staxis_remove_property_access_guarded_v2: {
        Args: {
          p_account_id: string
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_replace_finding_action: {
        Args: {
          p_action_kind: string
          p_finding_id: string
          p_params: Json
          p_property_id: string
          p_supersede_id: string
          p_verify: Json
        }
        Returns: Json
      }
      staxis_replace_staff_schedule_days: {
        Args: {
          p_days: Json
          p_property_id: string
          p_published_by: string
        }
        Returns: Json
      }
      staxis_require_inventory_section: {
        Args: { p_property_id: string }
        Returns: undefined
      }
      staxis_reserve_agent_spend: {
        Args: {
          p_estimated_usd: number
          p_global_cap_usd?: number
          p_property_cap_usd?: number
          p_property_id: string
          p_user_cap_usd?: number
          p_user_id: string
        }
        Returns: {
          global_spend_usd: number
          ok: boolean
          property_spend_usd: number
          reason: string
          reservation_id: string
          user_spend_usd: number
        }[]
      }
      staxis_reserve_findings_spend: {
        Args: {
          p_abandon_after_minutes?: number
          p_cap_usd: number
          p_estimated_usd: number
          p_feature: string
          p_property_id: string
        }
        Returns: {
          cap_usd: number
          ok: boolean
          property_spend_usd: number
          reason: string
          reservation_id: string
        }[]
      }
      staxis_reserve_phone_pairing_resend: {
        Args: { p_challenge_token_hash: string }
        Returns: {
          account_id: string
          auth_user_id: string
          challenge_expires_at: string
          pairing_id: string
          send_count: number
          send_reservation_id: string
        }[]
      }
      staxis_resolve_authorization_scope: {
        Args: {
          p_account_id: string
          p_organization_id?: string
          p_portfolio_id?: string
          p_property_ids?: Json
          p_selector_type?: string
          p_ttl_seconds?: number
        }
        Returns: Json
      }
      staxis_resolve_join_code_capability: {
        Args: { p_code: string }
        Returns: Json
      }
      staxis_resolve_or_mint_resume_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_resolve_organization_property_topology: {
        Args: { p_effective_at: string; p_organization_id: string }
        Returns: Json
      }
      staxis_restore_conversation: {
        Args: { p_conversation_id: string }
        Returns: number
      }
      staxis_review_organization_access_request: {
        Args: {
          p_actor_account_id: string
          p_decision: string
          p_expires_at?: string
          p_request_id: string
          p_review_note?: string
        }
        Returns: string
      }
      staxis_revoke_account_invite_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_invite_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_revoke_organization_access: {
        Args: {
          p_actor_account_id: string
          p_grant_id: string
          p_reason: string
        }
        Returns: boolean
      }
      staxis_revoke_staff_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_rollup_agent_costs_month: {
        Args: { p_month: string }
        Returns: {
          grains: number
          month: string
          raw_cost_usd: number
          rolled_cost_usd: number
          rows_folded: number
          verified: boolean
        }[]
      }
      staxis_save_inventory_count: {
        Args: {
          p_counted_at: string
          p_counted_by: string
          p_property_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      staxis_save_inventory_count_0334_impl: {
        Args: {
          p_counted_at: string
          p_counted_by: string
          p_property_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      staxis_save_inventory_count_for_actor: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_counted_at: string
          p_counted_by: string
          p_property_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      staxis_schedule_auto_fill_if_absent: {
        Args: {
          p_crew: string[]
          p_csv_pulled_at: string
          p_csv_room_snapshot: Json
          p_date: string
          p_property: string
          p_room_assignments: Json
          p_staff_names: Json
        }
        Returns: boolean
      }
      staxis_search_knowledge_chunks:
        | {
            Args: {
              p_dept: string
              p_include_manager_only: boolean
              p_match_count: number
              p_property_id: string
              p_query_embedding: string
            }
            Returns: {
              article_id: string
              chunk_index: number
              content: string
              document_id: string
              id: string
              section: string
              similarity: number
              source_type: string
              visibility: string
            }[]
          }
        | {
            Args: {
              p_include_manager_only: boolean
              p_match_count: number
              p_property_id: string
              p_query_embedding: string
            }
            Returns: {
              article_id: string
              chunk_index: number
              content: string
              document_id: string
              id: string
              section: string
              similarity: number
              source_type: string
              visibility: string
            }[]
          }
      staxis_set_company_finding_verdict_cas: {
        Args: {
          p_account_id: string
          p_action: string
          p_authorization_receipt_id: string
          p_expected_affected_property_ids: string[]
          p_expected_status: string
          p_expected_status_changed_at: string
          p_expected_verdict_revision: number
          p_finding_id: string
          p_organization_id: string
        }
        Returns: Json
      }
      staxis_set_membership_hat: {
        Args: {
          p_account_id: string
          p_actor_account_id: string
          p_job_title?: string
          p_membership_scope: string
          p_organization_id: string
          p_property_ids?: Json
          p_staxis_role: string
        }
        Returns: string
      }
      staxis_set_membership_hat_guarded: {
        Args: {
          p_account_id: string
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_audit_request_id?: string
          p_job_title?: string
          p_membership_scope: string
          p_organization_id: string
          p_property_ids?: Json
          p_staxis_role: string
        }
        Returns: Json
      }
      staxis_set_primary_property_organization: {
        Args: {
          p_actor_account_id: string
          p_organization_id: string
          p_property_id: string
          p_relationship_type?: string
        }
        Returns: string
      }
      staxis_set_report_inbox: {
        Args: { p_local: string; p_property_id: string }
        Returns: string
      }
      staxis_set_staff_language: {
        Args: { p_conf_token: string; p_lang: string; p_staff: string }
        Returns: undefined
      }
      staxis_start_inventory_month_close: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_month_start: string
          p_property_id: string
          p_request_id: string
        }
        Returns: string
      }
      staxis_store_company_fact: {
        Args: {
          p_cap?: number
          p_category?: string
          p_content: string
          p_created_by_account_id?: string
          p_created_by_name?: string
          p_created_by_role?: string
          p_organization_id: string
          p_source?: string
          p_topic: string
        }
        Returns: {
          action: string
          fact_id: string
        }[]
      }
      staxis_store_memory: {
        Args: {
          p_confidence?: string
          p_content: string
          p_created_by_account_id?: string
          p_created_by_name?: string
          p_created_by_role?: string
          p_expires_at?: string
          p_property_cap?: number
          p_property_id: string
          p_scope: string
          p_source?: string
          p_source_conversation_id?: string
          p_subject_account_id: string
          p_topic: string
          p_user_cap?: number
        }
        Returns: {
          action: string
          memory_id: string
        }[]
      }
      staxis_store_phone_pairing_otp: {
        Args: {
          p_challenge_token_hash: string
          p_otp_digest: string
          p_pairing_id: string
          p_send_count: number
          p_send_reservation_id: string
          p_supabase_hashed_token: string
        }
        Returns: boolean
      }
      staxis_swap_active_recipe: {
        Args: { p_new_recipe_id: string; p_pms_type: string }
        Returns: undefined
      }
      staxis_sweep_stale_reservations: {
        Args: { p_max_age_minutes?: number }
        Returns: {
          oldest_age_seconds: number
          swept_count: number
        }[]
      }
      staxis_transfer_ownership: {
        Args: {
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_property_id: string
        }
        Returns: string
      }
      staxis_transfer_ownership_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_new_active: boolean
          p_expected_new_auth_user_id: string
          p_expected_new_intent_version: number
          p_expected_new_property_access: string[]
          p_expected_new_role: string
          p_expected_old_active: boolean
          p_expected_old_auth_user_id: string
          p_expected_old_intent_version: number
          p_expected_old_property_access: string[]
          p_expected_old_role: string
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_operation_id: string
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_undo_finding_action: {
        Args: {
          p_account_id: string
          p_action_id: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_update_hotel_team_profile_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_change_display_name: boolean
          p_change_staff_link: boolean
          p_expected_active: boolean
          p_expected_auth_user_id: string
          p_expected_display_name: string
          p_expected_intent_version: number
          p_expected_property_access: string[]
          p_expected_role: string
          p_expected_staff_id: string
          p_expected_target_property_ids: string[]
          p_expected_updated_at: string
          p_hotel_id: string
          p_new_display_name: string
          p_new_staff_id: string
          p_request_id: string
          p_target_account_id: string
        }
        Returns: Json
      }
      staxis_update_inventory_property_config: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_budget_mode: string
          p_property_id: string
          p_tab_layout: Json
        }
        Returns: boolean
      }
      staxis_update_inventory_vendor: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_patch: Json
          p_property_id: string
          p_vendor_id: string
        }
        Returns: Json
      }
      staxis_upsert_scraper_credentials: {
        Args: {
          p_login_url: string
          p_password: string
          p_pms_type: string
          p_property_id: string
          p_username: string
        }
        Returns: undefined
      }
      staxis_user_can_manage_equipment: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_manage_inventory_operations: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_manage_staff: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_mutate_property: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_view_inventory_financials: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_verify_legacy_archived_inventory_zero: {
        Args: {
          p_expected_archived_at: string
          p_item_id: string
          p_property_id: string
          p_reason: string
          p_request_id: string
          p_verified_by: string
        }
        Returns: Json
      }
      staxis_verify_legacy_archived_inventory_zero_0394_impl: {
        Args: {
          p_expected_archived_at: string
          p_item_id: string
          p_property_id: string
          p_reason: string
          p_request_id: string
          p_verified_by: string
        }
        Returns: Json
      }
      staxis_verify_phone_pairing: {
        Args: {
          p_challenge_token_hash: string
          p_completion_token_hash: string
          p_otp_digest: string
        }
        Returns: {
          auth_user_id: string
          completion_expires_at: string
          pairing_id: string
          supabase_hashed_token: string
          verified: boolean
        }[]
      }
      staxis_walkthrough_end: {
        Args: { p_run_id: string; p_status: string }
        Returns: undefined
      }
      staxis_walkthrough_heal_stale: {
        Args: { p_dry_run?: boolean }
        Returns: number
      }
      staxis_walkthrough_start: {
        Args: { p_property_id: string; p_task: string; p_user_id: string }
        Returns: string
      }
      staxis_walkthrough_step: {
        Args: {
          p_expected_property_id?: string
          p_expected_user_id?: string
          p_run_id: string
        }
        Returns: number
      }
      staxis_write_inventory_tab_layout_ordered: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_budget_mode: string
          p_expected_revision: number
          p_operation_id: string
          p_property_id: string
          p_tab_layout: Json
        }
        Returns: Json
      }
      today_property_counts_v1: {
        Args: { p_date: string; p_property_id: string }
        Returns: {
          checkouts: number
          in_house: number
          ooo: number
          stayovers: number
          total_checkouts_today: number
          total_rooms: number
          vacant_clean: number
          vacant_dirty: number
        }[]
      }
      today_room_work_v1: {
        Args: { p_date: string; p_property_id: string }
        Returns: {
          housekeeper: string
          room_number: string
          stay_type: string
          stayover_day: number
        }[]
      }
      user_manages_property: { Args: { p_id: string }; Returns: boolean }
      user_owns_property: { Args: { p_id: string }; Returns: boolean }
    }
    Enums: {
      cleaning_event_status:
        "recorded" | "discarded" | "flagged" | "approved" | "rejected"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      cleaning_event_status: [
        "recorded",
        "discarded",
        "flagged",
        "approved",
        "rejected",
      ],
    },
  },
} as const
