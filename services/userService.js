const supabase = require('../config/supabase');

const TABLE_NAME = 'users';

const findAll = async () => {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('*');

  if (error) throw error;
  return data;
};

const findById = async (id) => {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
};

const create = async (userData) => {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert([userData])
    .select()
    .single();

  if (error) throw error;
  return data;
};

const update = async (id, userData) => {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update(userData)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
};

const remove = async (id) => {
  const { error } = await supabase
    .from(TABLE_NAME)
    .delete()
    .eq('id', id);

  if (error) throw error;
  return true;
};

module.exports = {
  findAll,
  findById,
  create,
  update,
  remove
};
